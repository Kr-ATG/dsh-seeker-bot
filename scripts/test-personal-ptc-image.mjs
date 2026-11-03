/**
 * dsh-seeker-bot — PTC 子调用 → 生图卡的回归测试（scripts/test-personal-ptc-image.mjs）。
 *
 * 背景（2026-11-03 用户实测）：「生图的点阵图没了，图片也不展示在对话里」。
 * Bot 会话挂的是 `ptc` preset，模型在 run_code 里 `await tools.generate_image(...)`，
 * 宿主只发 `tool/ptc-dispatch-start` / `tool/ptc-dispatch`，**不发** `tool/call` /
 * `tool/result`。宿主侧不接这两条事件时，生图卡整块消失：没有点阵占位，也没有图。
 *
 * 本测试用 fake ctx / fake agent 驱动真实的 runBotTurn，断言：
 *   1. dispatch-start 推出一张 running 的生图块（前端据此画点阵）；
 *   2. dispatch 收口后同一张卡变 ok，且带上落盘后的图片 URL 与模型名；
 *   3. 图片真的写进了 bot 工作区的 _tmp/generated-images；
 *   4. 结果被 spill 换成 locator 时（真实场景：3.5MB 大图）同样能读回；
 *   5. 非生图子调用（pwsh）不产生工具块（Bot 消息里不出现工具卡的约定）。
 *
 * 环境隔离：DSH_HOME 与 DSH_SEEKER_BOT_WORKSPACE 都指到系统临时目录；
 * spill 用例自己建一个 `dsh-spill-XXXXXX` 形状的临时 root，结束时删除。
 *
 * 直接用 Node 运行（Node 22.18+ / 24 原生剥离 TS 类型）：
 *   node scripts/test-personal-ptc-image.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-ptc-image-test-'))
process.env.DSH_HOME = join(tempRoot, 'dsh-home')
const workspace = join(tempRoot, 'workspace')
process.env.DSH_SEEKER_BOT_WORKSPACE = workspace

let failed = 0
const pass = (msg) => console.log(`✓ ${msg}`)
const fail = (msg) => {
  failed += 1
  console.error(`✗ ${msg}`)
}
const assert = (cond, msg) => {
  if (cond) pass(msg)
  else fail(msg)
}
const assertEqual = (actual, expected, msg) => {
  if (actual === expected) pass(msg)
  else fail(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)
}

/** 1×1 PNG：只要 magic number 合法，落盘与展示都不关心内容。 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
/** 第二张：只改尾部字符，让 sha1 与第一张不同（落盘成两个文件）。 */
const PNG_B64_ALT = `${PNG_B64.slice(0, -8)}AAAAAAA=`

const imageResultText = (model, b64) => JSON.stringify({ ok: true, model, data: { data: [{ b64_json: b64 }] } })

/**
 * 最小 fake 环境：一个 bot 会话 + 事件总线。
 * @param {string} botId - Bot id（同时决定 session id）。
 * @param {{ root: string } | null} spillStore - 需要覆盖 spill 分支时传入。
 */
function createHarness(botId, spillStore = null) {
  const listeners = new Set()
  const streamEvents = []
  let seq = 0
  const session = {
    id: `pa-bot-v2-${botId}`,
    header: { cwd: workspace },
    append() {},
    surface: { nodes: [] },
  }
  const emitEvent = (type, data) => {
    seq += 1
    for (const handler of [...listeners]) {
      handler(session, { seq, type, time: Date.now(), data })
    }
  }
  const agent = {
    session,
    ctx: {
      on(type, handler) {
        if (type !== 'session/event') return () => {}
        listeners.add(handler)
        return () => listeners.delete(handler)
      },
      systemPrompt: { section() {} },
      tools: { register() {} },
    },
    inject() {},
    model: { select() {} },
    followup() {},
  }
  const ctx = {
    on: () => () => {},
    get(name) {
      if (name === 'agents') return ctx.agents
      if (name === 'spillStore' && spillStore !== null) return spillStore
      return undefined
    },
    agents: {
      get: () => undefined,
      create: async ({ setup }) => {
        if (typeof setup === 'function') await setup(agent.ctx)
        return { agent }
      },
    },
  }
  return { agent, ctx, streamEvents, emitEvent }
}

/** 一轮里最典型的 PTC 生图事件序列。 */
function scriptImageTurn(emitEvent, { subCallId, prompt, size, n, resultText }) {
  emitEvent('tool/call', {
    callId: 'call-run-code-1',
    name: 'run_code',
    arguments: JSON.stringify({ code: 'await tools.generate_image({...})' }),
  })
  const args = { prompt, size, n }
  emitEvent('tool/ptc-dispatch-start', {
    rootCallId: 'call-run-code-1',
    parentCallId: 'call-run-code-1',
    subCallId,
    name: 'generate_image',
    arguments: args,
  })
  /* 非生图子调用：不该产生任何工具块。 */
  emitEvent('tool/ptc-dispatch-start', {
    rootCallId: 'call-run-code-1',
    parentCallId: 'call-run-code-1',
    subCallId: `${subCallId}-pwsh`,
    name: 'pwsh',
    arguments: { command: 'Get-ChildItem' },
  })
  emitEvent('tool/ptc-dispatch', {
    rootCallId: 'call-run-code-1',
    parentCallId: 'call-run-code-1',
    subCallId: `${subCallId}-pwsh`,
    name: 'pwsh',
    arguments: { command: 'Get-ChildItem' },
    isError: false,
    content: [{ type: 'text', text: 'OK' }],
  })
  emitEvent('tool/ptc-dispatch', {
    rootCallId: 'call-run-code-1',
    parentCallId: 'call-run-code-1',
    subCallId,
    name: 'generate_image',
    arguments: args,
    isError: false,
    content: [{ type: 'text', text: resultText }],
  })
  emitEvent('assistant/message', { message: { content: [{ type: 'text', text: '出好了。' }] } })
  emitEvent('turn/end', { reason: 'stop' })
}

let spillRoot = null
try {
  const { runBotTurn } = await import(pathToFileURL(join(ROOT, 'src', 'host', 'personal', 'agent.ts')).href)

  /* ── 1. 内联结果：点阵占位 → 带图的卡 ─────────────────────────────── */
  {
    const botId = 'ptc-image-bot'
    const harness = createHarness(botId)
    harness.agent.followup = () => scriptImageTurn(harness.emitEvent, {
      subCallId: 'call-run-code-1:ptc:1',
      prompt: '氷越しの夏',
      size: '1024x1536',
      n: 1,
      resultText: imageResultText('test/image-model', PNG_B64),
    })

    const turn = await runBotTurn(
      harness.ctx,
      { botId, name: 'PTC 生图机器人', role: '助手', description: '', instructions: '', model: { provider: 'test-provider', model: 'test-model' } },
      '生成一张氷越しの夏',
      (event) => harness.streamEvents.push(event),
    )
    assertEqual(turn.ok, true, 'runBotTurn 跑完一轮（fake agent）')

    const toolStreams = harness.streamEvents.filter((event) => event.type === 'tool')
    const runningCard = toolStreams.find((event) => event.run?.name === 'generate_image' && event.run?.status === 'running')
    assert(runningCard !== undefined, 'dispatch-start 推出 running 的生图块（前端画点阵）')
    assertEqual(runningCard?.run?.imageCount, 1, '点阵占位拿到张数 n=1')
    assert(Math.abs((runningCard?.run?.imageRatio ?? 0) - 1024 / 1536) < 1e-6, '点阵占位拿到宽高比 1024x1536')
    assertEqual(runningCard?.run?.prompt, '氷越しの夏', '点阵占位拿到完整提示词')

    const settledCard = [...toolStreams].reverse().find((event) => event.run?.name === 'generate_image')
    assertEqual(settledCard?.run?.status, 'ok', 'dispatch 收口后生图块状态为 ok')
    assertEqual(settledCard?.run?.model, 'test/image-model', '生图块带上模型名')
    const images = settledCard?.run?.images ?? []
    assertEqual(images.length, 1, '生图块带 1 张图片')
    assert(
      typeof images[0] === 'string' && images[0].startsWith('/api/personal-agent/file?path='),
      '图片地址走宿主文件路由（前端可直接 <img src>）',
    )

    const outDir = join(workspace, '_tmp', 'generated-images')
    assert(existsSync(outDir), '图片落盘目录已创建')
    const files = existsSync(outDir) ? readdirSync(outDir) : []
    assert(files.length === 1 && files[0].endsWith('.png'), '工作区里落下一张 png')

    const pwshCard = toolStreams.find((event) => event.run?.name === 'pwsh')
    assertEqual(pwshCard, undefined, 'pwsh 子调用不产生工具块（Bot 消息里不出现工具卡）')

    const blockCards = turn.blocks.filter((block) => block.type === 'tool' && block.run?.name === 'generate_image')
    assertEqual(blockCards.length, 1, 'TurnResult.blocks 里只有一张生图卡（没有裂成两张）')
    assertEqual((blockCards[0]?.run?.images ?? []).length, 1, 'TurnResult.blocks 里的生图卡同样带图')
  }

  /* ── 2. spill 结果：大图被换成 locator 时同样能读回 ───────────────── */
  /*
   * 真实场景里 3.5MB 的生图结果 100% 会被 spill：content 里只剩一行
   * 「Full formatted result stored at: <路径>」。这条路径必须走通，否则卡片
   * 会一直停在「ok 但没有图」——那正是用户报的现象的一半。
   */
  spillRoot = mkdtempSync(join(tmpdir(), 'dsh-spill-'))
  const spillSession = join(spillRoot, 'session-0123456789ab')
  mkdirSync(spillSession, { recursive: true })
  const spillFile = join(spillSession, 'f4c7e0f91897-generate_image.txt')
  writeFileSync(spillFile, imageResultText('test/image-model-spill', PNG_B64_ALT), 'utf8')

  {
    const botId = 'ptc-image-spill-bot'
    const harness = createHarness(botId, { root: spillRoot })
    harness.agent.followup = () => scriptImageTurn(harness.emitEvent, {
      subCallId: 'call-run-code-2:ptc:1',
      prompt: 'spill 场景',
      size: '1024x1024',
      n: 2,
      resultText: `(Omitted 3712515 bytes. Full formatted result stored at: ${spillFile}. Use read with offset/limit, or grep this path to search within it.)`,
    })

    const turn = await runBotTurn(
      harness.ctx,
      { botId, name: 'PTC spill 机器人', role: '助手', description: '', instructions: '', model: { provider: 'test-provider', model: 'test-model' } },
      '生成一张大图',
      (event) => harness.streamEvents.push(event),
    )
    assertEqual(turn.ok, true, 'spill 用例跑完一轮')

    const settled = [...harness.streamEvents].reverse().find((event) => event.type === 'tool' && event.run?.name === 'generate_image')
    assertEqual(settled?.run?.status, 'ok', 'spill 用例：生图块状态为 ok')
    assertEqual((settled?.run?.images ?? []).length, 1, 'spill 用例：从 spill 文件里读回 1 张图')
    assertEqual(settled?.run?.model, 'test/image-model-spill', 'spill 用例：模型名来自 spill 全文')
  }
  /* ── 3. 文档进度：模型用 document_progress 声明（不再猜关键词）──────── */
  /*
   * 旧实现拿参数关键词猜（.docx / python-docx）：猜不中整段空白，猜中了也只是
   * 碰巧。现在由模型自己声明——start 挂占位、done 收起，判据是事实而不是关键词。
   */
  {
    const botId = 'ptc-doc-bot'
    const harness = createHarness(botId)
    harness.agent.followup = () => {
      harness.emitEvent('tool/call', {
        callId: 'call-run-code-3',
        name: 'run_code',
        arguments: JSON.stringify({ code: 'await tools.document_progress({...})' }),
      })
      harness.emitEvent('tool/ptc-dispatch-start', {
        rootCallId: 'call-run-code-3',
        parentCallId: 'call-run-code-3',
        subCallId: 'call-run-code-3:ptc:1',
        name: 'document_progress',
        arguments: { phase: 'start', format: 'docx', title: '季度复盘 Word 报告' },
      })
      harness.emitEvent('tool/ptc-dispatch', {
        rootCallId: 'call-run-code-3',
        parentCallId: 'call-run-code-3',
        subCallId: 'call-run-code-3:ptc:1',
        name: 'document_progress',
        arguments: { phase: 'start', format: 'docx', title: '季度复盘 Word 报告' },
        isError: false,
        content: [{ type: 'text', text: '已记录文档生成进度' }],
      })
      harness.emitEvent('tool/ptc-dispatch-start', {
        rootCallId: 'call-run-code-3',
        parentCallId: 'call-run-code-3',
        subCallId: 'call-run-code-3:ptc:2',
        name: 'document_progress',
        arguments: { phase: 'done' },
      })
      harness.emitEvent('tool/ptc-dispatch', {
        rootCallId: 'call-run-code-3',
        parentCallId: 'call-run-code-3',
        subCallId: 'call-run-code-3:ptc:2',
        name: 'document_progress',
        arguments: { phase: 'done' },
        isError: false,
        content: [{ type: 'text', text: '已记录文档生成进度' }],
      })
      harness.emitEvent('turn/end', { reason: 'stop' })
    }

    const turn = await runBotTurn(
      harness.ctx,
      { botId, name: 'PTC 文档机器人', role: '助手', description: '', instructions: '', model: { provider: 'test-provider', model: 'test-model' } },
      '把结论整理成 Word',
      (event) => harness.streamEvents.push(event),
    )
    assertEqual(turn.ok, true, '文档声明用例跑完一轮')

    const runningDoc = harness.streamEvents.find(
      (event) => event.type === 'tool' && event.run?.docPending === true && event.run?.status === 'running',
    )
    assert(runningDoc !== undefined, 'document_progress(start) 推出「正在生成文档」点阵占位')
    assertEqual(runningDoc?.run?.args, '季度复盘 Word 报告', '占位副标题取声明里的 title')
    const settledDoc = [...harness.streamEvents]
      .reverse()
      .find((event) => event.type === 'tool' && event.run?.docPending === true)
    assertEqual(settledDoc?.run?.status, 'ok', 'document_progress(done) 收起占位（不残留转圈）')
  }

  /* ── 4. 文件系统兜底：模型漏声明时，文档文件写出来也命中 ───────────── */
  /*
   * 主路径是模型声明；但模型可能漏调。漏掉就整段空白，等于没命中。
   * 这条兜底看的是事实：工作区里真的写出了一个 docx，就补一块占位。
   */
  {
    const botId = 'ptc-doc-watch-bot'
    const harness = createHarness(botId)
    harness.agent.followup = () => {
      harness.emitEvent('tool/call', {
        callId: 'call-run-code-4',
        name: 'run_code',
        arguments: JSON.stringify({ code: '// 直接写文件，没有声明' }),
      })
      // 模拟模型用脚本写出 docx（没有任何 document_progress 声明）
      writeFileSync(join(workspace, '报告-2026-11-03.docx'), Buffer.from('PK fake docx payload'))
      // fs.watch 是异步投递的：轮询等到占位出现（或 3 秒超时）再收口
      const deadline = Date.now() + 3000
      const settleWhenSeen = () => {
        const hit = harness.streamEvents.some((event) => event.type === 'tool' && event.run?.docPending === true)
        if (!hit && Date.now() < deadline) {
          setTimeout(settleWhenSeen, 50)
          return
        }
        harness.emitEvent('assistant/message', { message: { content: [{ type: 'text', text: '报告好了。' }] } })
        harness.emitEvent('turn/end', { reason: 'stop' })
      }
      setTimeout(settleWhenSeen, 50)
    }

    const turn = await runBotTurn(
      harness.ctx,
      { botId, name: 'PTC 兜底机器人', role: '助手', description: '', instructions: '', model: { provider: 'test-provider', model: 'test-model' } },
      '写一份报告',
      (event) => harness.streamEvents.push(event),
    )
    assertEqual(turn.ok, true, '文件兜底用例跑完一轮')
    const docCard = harness.streamEvents.find((event) => event.type === 'tool' && event.run?.docPending === true)
    assert(docCard !== undefined, '模型漏声明时，工作区写出 docx 也会补一块文档进度占位')
    assert(
      String(docCard?.run?.args ?? '').includes('.docx'),
      '兜底占位的副标题是文件名',
    )
  }
} finally {
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    /* Windows 上偶发占用：临时目录由系统清理 */
  }
  if (spillRoot !== null) {
    try {
      rmSync(spillRoot, { recursive: true, force: true })
    } catch {
      /* 同上 */
    }
  }
}

if (failed > 0) {
  console.error(`\n[ptc image] ${failed} 项断言失败`)
  process.exitCode = 1
} else {
  console.log('\n[ptc image] PASS')
}
