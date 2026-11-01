/**
 * anysearch-auto 降级链的单测：错误分类、链的路由与熔断、三个后端的响应映射、
 * 以及注册模块的接线。全程不发真实网络请求（fetch 被替换成桩）。
 *
 * 跑法：`node scripts/test-web-search-chain.mjs`
 * 依赖 Node 的原生 TypeScript strip（Node ≥ 22.18 / 本机 24）：直接 import src 下的
 * `.ts`，所以这里不需要先 build。也正因如此，链上的类都不能用
 * `constructor(private readonly …)`——strip-only 模式会拒绝它。
 */
import assert from 'node:assert/strict'

const SRC = new URL('../src/provider/modules/', import.meta.url).href

const {
  ClassifiedWebError,
  WEB_AUTH_FAILED,
  WEB_QUOTA_EXCEEDED,
  WEB_RATE_LIMITED,
  WEB_UNAVAILABLE,
  classifyWebFailure,
  cooldownOf,
  isFallbackableCode,
  parseRetryAfter,
} = await import(`${SRC}web-search-failure.ts`)
const { WebError } = await import(new URL('../src/provider/vendor/error.ts', import.meta.url).href)
const { FallbackSearchProvider, DEFAULT_QUOTA_COOLDOWN_MS } = await import(`${SRC}web-search-chain.ts`)
const { mapAnySearchResponse } = await import(`${SRC}web-search-provider.ts`)
const { clampTavilyMaxResults, mapTavilyResponse, toIsoPublishedAt, TavilySearchProvider } = await import(`${SRC}web-search-tavily.ts`)
const { citationSnippets, mapAnthropicResponse, DeepSeekFallbackSearchProvider } = await import(`${SRC}web-search-deepseek-fallback.ts`)
const { applyWebSearchAuto, WEB_SEARCH_AUTO_PROVIDER_ID, WEB_SEARCH_AUTO_SETTINGS_NAMESPACE, AUTO_DEFAULT_ORDER } = await import(`${SRC}web-search-auto.ts`)

let passed = 0
const failures = []

function test(name, run) {
  return Promise.resolve()
    .then(run)
    .then(() => { passed += 1 }, (error) => { failures.push([name, error]) })
}

/** 造一个链上的环：可控结果、可控抛出、带调用次数记录。 */
function fakeLink(id, behavior = {}) {
  const state = { calls: 0, signals: [] }
  const link = {
    id,
    provider: {
      id,
      available: () => behavior.available ?? true,
      ...(behavior.ready === undefined ? {} : { ready: async () => behavior.ready }),
      search: async (request, signal) => {
        state.calls += 1
        state.signals.push(signal)
        if (typeof behavior.handler === 'function') return behavior.handler(request, state.calls)
        if (behavior.throw !== undefined) throw behavior.throw
        return { sources: [{ url: `https://${id}.test/q` }], truncated: false }
      },
    },
  }
  return { link, state }
}

class Clock {
  constructor(value = 0) { this.value = value }
  now = () => this.value
  advance(ms) { this.value += ms }
}

// ── 1. 错误分类：状态码优先，报文关键词兜底 ──────────────────────────────────

await test('classify: Tavily 的 432/433 与通用 402 都是额度耗尽', () => {
  assert.equal(classifyWebFailure({ status: 432, message: 'Tavily API error (HTTP 432): exceeds your plan\'s set usage limit' }), WEB_QUOTA_EXCEEDED)
  assert.equal(classifyWebFailure({ status: 433, message: 'exceeds the pay-as-you-go limit' }), WEB_QUOTA_EXCEEDED)
  assert.equal(classifyWebFailure({ status: 402, message: 'Payment Required' }), WEB_QUOTA_EXCEEDED)
})

await test('classify: 429/434 是速率与容量，401/403 是凭据', () => {
  assert.equal(classifyWebFailure({ status: 429, message: 'reduce the rate of requests' }), WEB_RATE_LIMITED)
  assert.equal(classifyWebFailure({ status: 434, message: 'Flex tier capacity exceeded' }), WEB_RATE_LIMITED)
  assert.equal(classifyWebFailure({ status: 401, message: 'Invalid API key.' }), WEB_AUTH_FAILED)
  assert.equal(classifyWebFailure({ status: 403, message: 'forbidden' }), WEB_AUTH_FAILED)
})

await test('classify: 400 是「换后端也必败」，不进可降级集合', () => {
  const code = classifyWebFailure({ status: 400, message: 'AnySearch API error (HTTP 400): Query is required.' })
  assert.equal(code, 'WEB_PROVIDER_ERROR')
  assert.equal(isFallbackableCode(code), false)
})

await test('classify: 5xx 与无状态码的网络失败算上游不可用（可切、不冷却）', () => {
  assert.equal(classifyWebFailure({ status: 503, message: 'boom' }), WEB_UNAVAILABLE)
  assert.equal(classifyWebFailure({ message: 'TypeError: fetch failed' }), WEB_UNAVAILABLE)
  assert.equal(cooldownOf(WEB_UNAVAILABLE, undefined, DEFAULT_QUOTA_COOLDOWN_MS), 0)
})

await test('classify: HTTP 200 + 业务 code 非零靠报文判定（含中文额度）', () => {
  assert.equal(classifyWebFailure({ errorCode: 'insufficient_quota', message: 'quota exhausted' }), WEB_QUOTA_EXCEEDED)
  assert.equal(classifyWebFailure({ message: '账户额度不足，请充值' }), WEB_QUOTA_EXCEEDED)
  assert.equal(classifyWebFailure({ errorCode: 'invalid_api_key', message: 'Invalid API key.' }), WEB_AUTH_FAILED)
})

await test('classify: 未知 4xx 不猜成额度问题', () => {
  assert.equal(classifyWebFailure({ status: 404, message: 'no such endpoint' }), 'WEB_PROVIDER_ERROR')
})

await test('cooldown: 额度长冷却，速率听 Retry-After 且封顶 15 分钟', () => {
  assert.equal(cooldownOf(WEB_QUOTA_EXCEEDED, undefined, DEFAULT_QUOTA_COOLDOWN_MS), DEFAULT_QUOTA_COOLDOWN_MS)
  assert.equal(cooldownOf(WEB_RATE_LIMITED, 120, DEFAULT_QUOTA_COOLDOWN_MS), 120_000)
  assert.equal(cooldownOf(WEB_RATE_LIMITED, 999_999, DEFAULT_QUOTA_COOLDOWN_MS), 15 * 60 * 1000)
  assert.equal(cooldownOf(WEB_RATE_LIMITED, undefined, DEFAULT_QUOTA_COOLDOWN_MS), 60_000)
  assert.equal(cooldownOf(WEB_AUTH_FAILED, 30, DEFAULT_QUOTA_COOLDOWN_MS), 10 * 60 * 1000)
  assert.equal(parseRetryAfter('120'), 120)
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT'), undefined)
  assert.equal(parseRetryAfter(null), undefined)
})

// ── 2. 链：路由、熔断、取消、聚合 ────────────────────────────────────────────

await test('chain: 首环成功就不碰后环', async () => {
  const a = fakeLink('anysearch')
  const b = fakeLink('tavily')
  const chain = new FallbackSearchProvider({ resolveLinks: () => [a.link, b.link] })
  const result = await chain.search({ query: 'x', maxResults: 5 })
  assert.equal(result.sources[0].url, 'https://anysearch.test/q')
  assert.equal(a.state.calls, 1)
  assert.equal(b.state.calls, 0)
  assert.equal(WEB_SEARCH_AUTO_PROVIDER_ID, 'anysearch-auto')
})

await test('chain: 额度失败切下一环，并让失败环进冷却', async () => {
  const clock = new Clock(0)
  const a = fakeLink('anysearch', { throw: new ClassifiedWebError('quota gone', WEB_QUOTA_EXCEEDED) })
  const b = fakeLink('tavily')
  const events = []
  const chain = new FallbackSearchProvider({
    resolveLinks: () => [a.link, b.link],
    now: clock.now,
    onEvent: (event) => events.push(event),
  })
  await chain.search({ query: 'x' })
  assert.equal(a.state.calls, 1)
  assert.equal(b.state.calls, 1)
  const fallback = events.find((event) => event.kind === 'fallback')
  assert.equal(fallback.from, 'anysearch')
  assert.equal(fallback.to, 'tavily')
  assert.equal(fallback.cooldownMs, DEFAULT_QUOTA_COOLDOWN_MS)

  // 冷却期内：不再白撞首环
  clock.advance(60_000)
  await chain.search({ query: 'y' })
  assert.equal(a.state.calls, 1, '冷却期内不该再打 anysearch')
  assert.equal(b.state.calls, 2)

  // 冷却到期：首环恢复优先
  clock.advance(DEFAULT_QUOTA_COOLDOWN_MS)
  await chain.search({ query: 'z' })
  assert.equal(a.state.calls, 2, '冷却到期后必须重新先试首环')
})

await test('chain: 全环都在冷却时忽略冷却重走，绝不永久锁死', async () => {
  const clock = new Clock(0)
  const a = fakeLink('anysearch', { throw: new ClassifiedWebError('quota', WEB_QUOTA_EXCEEDED) })
  const b = fakeLink('tavily', { throw: new ClassifiedWebError('quota', WEB_QUOTA_EXCEEDED) })
  const chain = new FallbackSearchProvider({ resolveLinks: () => [a.link, b.link], now: clock.now })
  await assert.rejects(() => chain.search({ query: 'x' }))
  assert.equal(chain.coolingRemaining().anysearch > 0, true)
  await assert.rejects(() => chain.search({ query: 'y' }))
  assert.equal(a.state.calls, 2, '全冷却也必须重试')
  assert.equal(b.state.calls, 2)
})

await test('chain: 取消原样上抛，一家都不多打', async () => {
  const a = fakeLink('anysearch', { throw: new WebError('anysearch search aborted', 'WEB_ABORTED') })
  const b = fakeLink('tavily')
  const chain = new FallbackSearchProvider({ resolveLinks: () => [a.link, b.link] })
  await assert.rejects(() => chain.search({ query: 'x' }), (error) => error.code === 'WEB_ABORTED')
  assert.equal(b.state.calls, 0, '取消不是「这家不行」，绝不能继续降级')
})

await test('chain: 搜索进行中 abort，信号必须传到每一环', async () => {
  const controller = new AbortController()
  const a = fakeLink('anysearch', { handler: async () => { controller.abort(); throw new WebError('aborted', 'WEB_ABORTED') } })
  const chain = new FallbackSearchProvider({ resolveLinks: () => [a.link] })
  await assert.rejects(() => chain.search({ query: 'x' }, controller.signal))
  assert.equal(a.state.signals[0], controller.signal)
})

await test('chain: 不可降级的失败直接上抛，不烧第二家额度', async () => {
  const a = fakeLink('anysearch', { throw: new ClassifiedWebError('Query is required.', 'WEB_PROVIDER_ERROR') })
  const b = fakeLink('tavily')
  const chain = new FallbackSearchProvider({ resolveLinks: () => [a.link, b.link] })
  await assert.rejects(() => chain.search({ query: '' }), (error) => error.code === 'WEB_PROVIDER_ERROR')
  assert.equal(b.state.calls, 0)
})

await test('chain: 后端抛非 WebError 按上游故障处理——切走但不冷却', async () => {
  const a = fakeLink('anysearch', { throw: new Error('TypeError: fetch failed') })
  const b = fakeLink('tavily')
  const chain = new FallbackSearchProvider({ resolveLinks: () => [a.link, b.link] })
  await chain.search({ query: 'x' })
  assert.equal(b.state.calls, 1)
  assert.deepEqual(chain.coolingRemaining(), {}, '5xx 类抖动不该被冷却挡住的等价处理成长期惩罚')
  await chain.search({ query: 'y' })
  assert.equal(a.state.calls, 2, '下一次仍然先试它')
})

await test('chain: 没配 key 的后备环不得拖死整条链（ready 预检先跳过它）', async () => {
  let calls = 0
  const noKey = {
    id: 'tavily',
    provider: {
      id: 'tavily',
      available: () => true, // available() 是同步的，判不出凭据库里有没有 key
      ready: async () => false,
      search: async () => { calls += 1; throw new WebError('Tavily search has no API key', 'WEB_PROVIDER_CREDENTIAL_MISSING') },
    },
  }
  const good = fakeLink('anysearch')
  const chain = new FallbackSearchProvider({ resolveLinks: () => [noKey, good.link] })
  const result = await chain.search({ query: 'x' })
  assert.equal(result.sources[0].url, 'https://anysearch.test/q')
  assert.equal(calls, 0, '预检不过的环一次都不该打')
})

await test('chain: 环自己报 CREDENTIAL_MISSING 时继续降级，且不冷却', async () => {
  let noKeyCalls = 0
  const noKey = {
    id: 'deepseek-official',
    provider: {
      id: 'deepseek-official',
      available: () => true,
      search: async () => { noKeyCalls += 1; throw new WebError('DeepSeek search has no API key', 'WEB_PROVIDER_CREDENTIAL_MISSING') },
    },
  }
  const good = fakeLink('anysearch')
  const chain = new FallbackSearchProvider({ resolveLinks: () => [noKey, good.link] })
  await chain.search({ query: 'x' })
  assert.equal(good.state.calls, 1, '没凭据这一家必须被跳过而不是终止整条链')
  assert.deepEqual(chain.coolingRemaining(), {}, '用户配好 key 就该立刻能用，不该被冷却挡住')
  await chain.search({ query: 'y' })
  assert.equal(noKeyCalls, 2, '不冷却：下一次仍然先试它')
})

await test('chain: 全部环预检不过时仍要试一遍，不得自我锁死', async () => {
  let calls = 0
  const link = {
    id: 'tavily',
    provider: { id: 'tavily', available: () => true, ready: async () => false, search: async () => { calls += 1; return { sources: [{ url: 'https://despite.test' }], truncated: false } } },
  }
  const chain = new FallbackSearchProvider({ resolveLinks: () => [link] })
  const result = await chain.search({ query: 'x' })
  assert.equal(result.sources[0].url, 'https://despite.test')
  assert.equal(calls, 1, 'ready 只是省一次白打，不是否决权')
})

await test('chain: 全链失败时把每一环的原因都聚出来', async () => {
  const a = fakeLink('anysearch', { throw: new ClassifiedWebError('额度耗尽', WEB_QUOTA_EXCEEDED) })
  const b = fakeLink('tavily', { throw: new ClassifiedWebError('invalid key', WEB_AUTH_FAILED) })
  const chain = new FallbackSearchProvider({ resolveLinks: () => [a.link, b.link] })
  await assert.rejects(() => chain.search({ query: 'x' }), (error) => {
    assert.equal(error.code, WEB_QUOTA_EXCEEDED, '有额度类失败时聚合码优先报额度')
    assert.match(error.message, /anysearch.*额度耗尽/su)
    assert.match(error.message, /tavily.*invalid key/su)
    assert.match(error.message, /all 2/u)
    return true
  })
})

await test('chain: available/ready 是聚合语义，且跳过没有凭据的环', async () => {
  const a = fakeLink('anysearch', { available: false })
  const b = fakeLink('tavily', { ready: false })
  const chain = new FallbackSearchProvider({ resolveLinks: () => [a.link, b.link] })
  assert.equal(chain.available(), true, 'b 可用即整链可用')
  assert.equal(await chain.ready('deepseek-official'), false, '唯一可用环报没有凭据 → 链报不可鉴权')

  const c = fakeLink('deepseek-official')
  const withC = new FallbackSearchProvider({ resolveLinks: () => [a.link, b.link, c.link] })
  assert.equal(await withC.ready(undefined), true, '没有 ready() 的后端按可鉴权算')

  const none = new FallbackSearchProvider({ resolveLinks: () => [fakeLink('x', { available: false }).link] })
  assert.equal(none.available(), false)
  await assert.rejects(() => none.search({ query: 'x' }), (error) => error.code === 'WEB_PROVIDER_UNAVAILABLE')
})

await test('chain: available() 自身抛错的后端不能拖垮整链', async () => {
  const bad = { id: 'bad', provider: { id: 'bad', available: () => { throw new Error('boom') }, search: async () => ({ sources: [], truncated: false }) } }
  const good = fakeLink('tavily')
  const chain = new FallbackSearchProvider({ resolveLinks: () => [bad, good.link] })
  assert.equal(chain.available(), true)
  await chain.search({ query: 'x' })
  assert.equal(good.state.calls, 1)
})

await test('chain: order 改了在下一轮搜索就生效（thunk 投影，不重注册）', async () => {
  let order = ['anysearch', 'tavily']
  const a = fakeLink('anysearch', { throw: new ClassifiedWebError('quota', WEB_QUOTA_EXCEEDED) })
  const b = fakeLink('tavily')
  const d = fakeLink('deepseek-official')
  const byId = { anysearch: a.link, tavily: b.link, 'deepseek-official': d.link }
  const chain = new FallbackSearchProvider({ resolveLinks: () => order.map((id) => byId[id]) })
  await chain.search({ query: 'x' })
  assert.equal(b.state.calls, 1)
  order = ['deepseek-official', 'tavily']
  await chain.search({ query: 'y' })
  assert.equal(d.state.calls, 1, '新顺序必须生效')
  assert.equal(a.state.calls, 1, '已被移出链的环不再被打')
})

await test('chain: 空链与配额冷却函数抛错都要兜住', async () => {
  const empty = new FallbackSearchProvider({ resolveLinks: () => [] })
  await assert.rejects(() => empty.search({ query: 'x' }), (error) => error.code === 'WEB_PROVIDER_UNAVAILABLE')
  const clock = new Clock(0)
  const a = fakeLink('anysearch', { throw: new ClassifiedWebError('quota', WEB_QUOTA_EXCEEDED) })
  const b = fakeLink('tavily')
  const broken = new FallbackSearchProvider({
    resolveLinks: () => [a.link, b.link],
    quotaCooldownMs: () => { throw new Error('bad settings') },
    now: clock.now,
  })
  await broken.search({ query: 'x' })
  assert.equal(a.state.calls, 1)
  assert.ok(chainCooling(broken), '冷却仍要按默认值生效')
})

function chainCooling(chain) {
  return Object.keys(chain.coolingRemaining()).length > 0
}

// ── 3. 响应映射 ──────────────────────────────────────────────────────────────

await test('anysearch: HTTP 200 但 code 非零时按 error_code 分类，不返回空结果', () => {
  // mapAnySearchResponse 是同步的：用 assert.throws，assert.rejects 接不到同步抛出。
  assert.throws(
    () => mapAnySearchResponse({ code: -1, message: 'Insufficient quota', error_code: 'quota_exceeded' }),
    (error) => error.code === WEB_QUOTA_EXCEEDED,
  )
  assert.throws(
    () => mapAnySearchResponse({ code: -1, message: 'Invalid API key.', error_code: 'invalid_api_key' }),
    (error) => error.code === WEB_AUTH_FAILED,
  )
  assert.throws(
    () => mapAnySearchResponse({ code: -1 }),
    (error) => /code -1/u.test(error.message) && error.code === WEB_UNAVAILABLE,
    '没有 message 时也要报出业务码，且按未知上游失败归类',
  )
  const mapped = mapAnySearchResponse({ code: 0, data: { results: [{ url: 'https://a.test', title: 'A', snippet: 's', published_at: '2026-01-01T00:00:00Z' }, { title: 'no url' }] } })
  assert.equal(mapped.sources.length, 1, '没有 url 的条目必须丢弃')
  assert.equal(mapped.truncated, false)
  assert.equal(mapped.content, undefined, 'AnySearch 不生成答案，content 必须缺席')
})

await test('tavily: max_results 钳进 0–20，越界不发出去（400 换后端也必败）', () => {
  assert.equal(clampTavilyMaxResults(25), 20)
  assert.equal(clampTavilyMaxResults(0), 1)
  assert.equal(clampTavilyMaxResults(5), 5)
  assert.equal(clampTavilyMaxResults(undefined), undefined)
  assert.equal(clampTavilyMaxResults(-3), undefined)
  assert.equal(clampTavilyMaxResults(1.5), undefined)
})

await test('tavily: answer 进 content、RFC-1123 日期转 ISO、按 url 去重', () => {
  const mapped = mapTavilyResponse({
    answer: ' 结论一句话 ',
    results: [
      { url: 'https://a.test', title: 'A', content: 'body', published_date: 'Tue, 11 Mar 2025 17:00:00 GMT' },
      { url: 'https://a.test', title: 'dup' },
      { url: '', content: 'no url' },
      { url: 'https://b.test', published_date: 'nonsense' },
    ],
  })
  assert.equal(mapped.content, ' 结论一句话 ')
  assert.equal(mapped.sources.length, 2)
  assert.equal(mapped.sources[0].publishedAt, '2025-03-11T17:00:00.000Z')
  assert.equal(mapped.sources[1].publishedAt, undefined, '解析不出来的日期宁可不带，不能把契约类型写脏')
  assert.equal(toIsoPublishedAt(''), undefined)
})

await test('tavily: fetch 432 抛额度码、429 带 Retry-After、200 正常映射', async () => {
  const real = globalThis.fetch
  try {
    const provider = new TavilySearchProvider(() => ({ apiKey: 'tvly-test', baseURL: 'https://api.tavily.test' }))
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body)
      assert.equal(init.headers.authorization, 'Bearer tvly-test')
      // 钳制只在调用方给了上限时才体现（没给就交给 Tavily 自己的默认 10）。
      if (body.query === 'clamp') {
        assert.equal(body.max_results, 20, '请求体里就该是钳制后的值')
      } else {
        assert.ok(body.max_results === undefined || body.max_results <= 20)
      }
      if (body.query === 'quota') {
        return new Response(JSON.stringify({ detail: { error: "exceeds your plan's set usage limit" } }), { status: 432 })
      }
      if (body.query === 'limited') {
        return new Response(JSON.stringify({ detail: { error: 'too many requests' } }), { status: 429, headers: { 'retry-after': '90' } })
      }
      return new Response(JSON.stringify({ query: body.query, results: [{ url: 'https://ok.test', content: 'x', title: 'T' }], response_time: 0.1 }), { status: 200 })
    }
    await assert.rejects(() => provider.search({ query: 'quota' }), (error) => error.code === WEB_QUOTA_EXCEEDED)
    await assert.rejects(() => provider.search({ query: 'limited' }), (error) => {
      assert.equal(error.code, WEB_RATE_LIMITED)
      assert.equal(error.retryAfterSeconds, 90)
      return true
    })
    const ok = await provider.search({ query: 'clamp', maxResults: 99 })
    assert.equal(ok.sources[0].url, 'https://ok.test')
    assert.equal(provider.available(), true)
    assert.equal(new TavilySearchProvider(() => ({ baseURL: 'https://api.tavily.test' })).available(), false, 'Tavily 没有匿名档：没 key 就不算可用')
  } finally {
    globalThis.fetch = real
  }
})

await test('deepseek: 无 result block 算上游不可用而不是查询错误', () => {
  assert.throws(
    () => mapAnthropicResponse({ content: [{ type: 'text', text: 'prose only' }] }),
    (error) => error.code === WEB_UNAVAILABLE,
  )
  assert.deepEqual(citationSnippets([]), new Map())
})

await test('deepseek: web_search_tool_result 与 text 块的 citation 按 url 联接', () => {
  const mapped = mapAnthropicResponse({
    content: [
      { type: 'server_tool_use', id: 'x' },
      { type: 'text', text: 'answer', citations: [{ url: 'https://a.test', cited_text: 'excerpt A' }, { url: 'https://a.test', cited_text: 'later wins not' }] },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://a.test', title: 'A', page_age: '3 days' },
          { type: 'web_search_result', url: 'https://a.test', title: 'dup' },
          { type: 'citation_error', url: 'ignored' },
        ],
      },
    ],
  })
  assert.equal(mapped.sources.length, 1)
  assert.equal(mapped.sources[0].snippet, 'excerpt A', '同一 url 的 citation 取第一次出现')
  assert.equal(mapped.sources[0].publishedAt, '3 days')
})

await test('deepseek: 402 报文按额度归类，请求体带原生 web_search 工具与 disabled thinking', async () => {
  const real = globalThis.fetch
  let captured
  try {
    globalThis.fetch = async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) }
      if (JSON.parse(init.body).messages[0].content[0].text.includes('quota')) {
        return new Response(JSON.stringify({ error: { message: 'insufficient_quota' } }), { status: 400 })
      }
      return new Response(JSON.stringify({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://ok.test' }] }] }), { status: 200 })
    }
    const provider = new DeepSeekFallbackSearchProvider(() => ({
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.test/anthropic/v1',
      model: 'deepseek-v4-flash',
      apiVersion: '2023-06-01',
      maxTokens: 4096,
      maxUses: 5,
    }))
    await assert.rejects(() => provider.search({ query: 'quota?' }), (error) => error.code === WEB_QUOTA_EXCEEDED)
    const ok = await provider.search({ query: 'plain' })
    assert.equal(ok.sources[0].url, 'https://ok.test')
    assert.equal(captured.url, 'https://api.deepseek.test/anthropic/v1/messages')
    assert.equal(captured.init.headers['x-api-key'], 'sk-test')
    assert.equal(captured.init.headers.authorization, 'Bearer sk-test')
    assert.equal(captured.init.headers['anthropic-version'], '2023-06-01')
    assert.equal(captured.body.tools[0].type, 'web_search_20250305')
    assert.equal(captured.body.thinking.type, 'disabled', '辅助 turn 的文本被丢弃，reasoning token 没有消费者')
    assert.equal(captured.init.redirect, 'error')
  } finally {
    globalThis.fetch = real
  }
})

await test('anysearch: 取消与无效 key 的处理在转发到共享叶之后必须一字不差', async () => {
  const { AnySearchSearchProvider } = await import(`${SRC}web-search-provider.ts`)
  const real = globalThis.fetch
  try {
    const provider = new AnySearchSearchProvider(() => ({ apiKey: 'k', baseURL: 'https://api.anysearch.test' }))
    globalThis.fetch = async (_url, init) => {
      const query = JSON.parse(init.body).query
      if (query === 'badkey') {
        // 2026-11-01 实测到的真实报文形状：401 + code -1 + error_code。
        return new Response(JSON.stringify({ code: -1, message: 'Invalid API key.', error_code: 'invalid_api_key' }), { status: 401 })
      }
      return new Response(JSON.stringify({ code: 0, message: 'success', data: { results: [{ url: 'https://ok.test', title: 'ok' }] } }), { status: 200 })
    }
    await assert.rejects(() => provider.search({ query: 'badkey' }), (error) => error.code === WEB_AUTH_FAILED)
    const ok = await provider.search({ query: 'fine' })
    assert.equal(ok.sources[0].url, 'https://ok.test')

    // 已经取消的信号必须以 WEB_ABORTED 退出，绝不能被算成「这家不行、切下一家」。
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      () => provider.search({ query: 'fine' }, controller.signal),
      (error) => error.code === 'WEB_ABORTED' && /AnySearch/u.test(error.message),
    )
  } finally {
    globalThis.fetch = real
  }
})

// ── 4. 注册接线 ──────────────────────────────────────────────────────────────

await test('register: 挂 web-search-auto 命名空间并注册 id=anysearch-auto 的链', async () => {
  const registered = []
  const namespaces = []
  const logs = []
  let source = () => ({})
  const ctx = {
    logger: { warn: (m) => logs.push(['warn', m]), info: (m) => logs.push(['info', m]), debug: () => {}, error: () => {} },
    inject(names, callback) { if (names.includes('settings')) callback(ctx); },
    // 宿主把 settings 挂在 ctx 属性上（installSettingsSection 读 sctx.settings），
    // 不是 ctx.get('settings')——桩必须照这个形状来，否则测的是空气。
    settings: {
      register(ns, schema, options) {
        namespaces.push(ns)
        source = () => schema(options.base)
        return { get: () => source(), watch: () => {}, update: async () => {} }
      },
    },
    get: () => undefined,
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    fiber: { state: 0 },
    web: { registerSearchProvider: (provider) => { registered.push(provider); return () => {} } },
  }
  const anysearch = fakeLink('anysearch').link.provider
  const chain = applyWebSearchAuto(ctx, { anysearch })
  assert.deepEqual(namespaces, [WEB_SEARCH_AUTO_SETTINGS_NAMESPACE])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'anysearch-auto')
  assert.equal(chain.id, 'anysearch-auto')
  assert.equal(registered[0], chain)

  // 默认段解析出的链顺序就是 AUTO_DEFAULT_ORDER 的三个环
  assert.equal(chain.available(), true)
  assert.equal(await chain.ready('deepseek-official'), true)

  // order 里写了不存在的环名：跳过它、链照常跑，并且只警告一次（不得每次搜索刷屏）。
  source = () => ({ order: 'anysearch,NoSuchBackend,tavily', quotaCooldownMinutes: 5, tavilyApiKeyEnv: 'TAVILY_API_KEY', deepseekApiKeyEnv: 'DEEPSEEK_API_KEY' })
  const result = await chain.search({ query: 'x' })
  assert.equal(result.sources.length, 1, '被跳过的是拼错的名字，anysearch 环仍要出结果')
  const warned = logs.filter((entry) => entry[0] === 'warn' && /NoSuchBackend/u.test(entry[1]))
  assert.equal(warned.length, 1)
  await chain.search({ query: 'y' })
  assert.equal(logs.filter((entry) => /NoSuchBackend/u.test(entry[1])).length, 1, '第二次搜索不得重复警告同一个名字')
})

await test('register: settings 服务缺席时用默认段照常注册', () => {
  const registered = []
  const ctx = {
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
    inject: () => {},
    get: () => undefined,
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    web: { registerSearchProvider: (provider) => { registered.push(provider); return () => {} } },
  }
  const chain = applyWebSearchAuto(ctx, {})
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, WEB_SEARCH_AUTO_PROVIDER_ID)
  assert.equal(chain.available(), true, '没有 anysearch 实例时 Tavily/DeepSeek 仍构成链')
})

await test('register: AUTO_DEFAULT_ORDER 的三个名字都能解析出来', () => {
  assert.deepEqual(
    AUTO_DEFAULT_ORDER.split(',').map((name) => name.trim()),
    ['anysearch', 'tavily', 'deepseek'],
  )
})

// ── 汇总 ────────────────────────────────────────────────────────────────────

console.log(`[web-search-chain] 通过 ${String(passed)} 项`)
for (const [name, error] of failures) {
  console.error(`✗ ${name}\n  ${String(error && error.stack ? error.stack : error)}`)
}
if (failures.length > 0) {
  console.error(`[web-search-chain] 失败 ${String(failures.length)} 项`)
  process.exitCode = 1
}
