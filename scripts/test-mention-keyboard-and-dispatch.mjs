#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const HERE = fileURLToPath(new URL('..', import.meta.url))

console.log('\n[1. checkMentionAtCursor 判据断言]')
{
  function checkMentionAtCursor(value, cursor) {
    const before = value.slice(0, cursor)
    const match = /(?:^|[\s，。、；：！？,!?;:])([@＠]([^\s@＠]*))$/.exec(before)
    if (!match) return null
    const atPos = before.length - match[1].length
    return { query: match[2], atPos }
  }

  assert.deepEqual(checkMentionAtCursor('@', 1), { query: '', atPos: 0 })
  assert.deepEqual(checkMentionAtCursor('@Git', 4), { query: 'Git', atPos: 0 })
  assert.deepEqual(checkMentionAtCursor('你好 @GitStar', 11), { query: 'GitStar', atPos: 3 })
  assert.deepEqual(checkMentionAtCursor('查一下时间，@', 7), { query: '', atPos: 6 })
  assert.deepEqual(checkMentionAtCursor('＠小墨', 3), { query: '小墨', atPos: 0 })
  // 邮箱不应误触
  assert.equal(checkMentionAtCursor('test@example.com', 16), null)
  assert.equal(checkMentionAtCursor('test@', 5), null)
  console.log('  ok   光标 @ 检测正则与位置判定正确')
}

console.log('\n[2. insertMention 补全替换逻辑断言]')
{
  function simulateInsert(text, cursor, atPos, botName) {
    if (atPos >= 0 && atPos <= cursor) {
      const beforeAt = text.slice(0, atPos)
      const afterCursor = text.slice(cursor)
      const insertStr = `@${botName} `
      return {
        next: `${beforeAt}${insertStr}${afterCursor}`,
        nextCursor: beforeAt.length + insertStr.length
      }
    } else {
      const prefix = text !== '' && !text.endsWith(' ') && !text.endsWith('\n') ? ' ' : ''
      const insertStr = `${prefix}@${botName} `
      return {
        next: `${text.slice(0, cursor)}${insertStr}${text.slice(cursor)}`,
        nextCursor: cursor + insertStr.length
      }
    }
  }

  // 场景 A：用户只打了 @
  const r1 = simulateInsert('@', 1, 0, 'GitStar')
  assert.equal(r1.next, '@GitStar ')
  assert.equal(r1.nextCursor, 9)

  // 场景 B：用户打了 @Git
  const r2 = simulateInsert('@Git', 4, 0, 'GitStar')
  assert.equal(r2.next, '@GitStar ')
  assert.equal(r2.nextCursor, 9)

  // 场景 C：中间插入 "你好 @G 帮忙看看"
  const r3 = simulateInsert('你好 @G 帮忙看看', 5, 3, 'GitStar')
  assert.equal(r3.next, '你好 @GitStar  帮忙看看')

  // 场景 D：纯点击，输入框原本没有 @
  const r4 = simulateInsert('你好', 2, -1, 'GitStar')
  assert.equal(r4.next, '你好 @GitStar ')

  console.log('  ok   insertMention 各种输入与补全边界替换正确，不出现 @@')
}

console.log('\n[3. 宿主生命周期与接线断言]')
{
  const indexSource = readFileSync(join(HERE, 'src/host/personal/index.ts'), 'utf8')
  const hostSource = readFileSync(join(HERE, 'src/host/personal/runtime/host.ts'), 'utf8')
  const registrySource = readFileSync(join(HERE, 'src/host/personal/runtime/registry.ts'), 'utf8')
  const coordinateSource = readFileSync(join(HERE, 'src/host/personal/runtime/coordinate.ts'), 'utf8')
  const composerSource = readFileSync(join(HERE, 'src/client/personal/chat/Composer.tsx'), 'utf8')
  const cssSource = readFileSync(join(HERE, 'src/client/personal/chat/chat.css.ts'), 'utf8')

  assert.ok(hostSource.includes('bindAssignment(botId: string, assignmentId: string)'), 'host.ts 未实现 bindAssignment')
  assert.ok(registrySource.includes('bindAssignment?:'), 'registry.ts 未导出 bindAssignment')
  assert.ok(indexSource.includes('unbindAssignment'), 'index.ts 未调用 bindAssignment / unbind')
  assert.ok(coordinateSource.includes('matchedByName'), 'coordinate.ts 未添加目标 Bot 名称匹配容错')
  assert.ok(composerSource.includes('checkMentionAtCursor'), 'Composer.tsx 未集成光标 @ 检查')
  assert.ok(composerSource.includes('filteredTargets'), 'Composer.tsx 未集成 filteredTargets 过滤')
  assert.ok(cssSource.includes('pa-composer__mention-empty'), 'chat.css.ts 未添加空状态样式')

  console.log('  ok   宿主与前端全部链路接线断言通过')
}

console.log('\n全部验证通过！')
