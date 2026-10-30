import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { routeHeaderValue, toHeaderValue } from '../../src/main/proxy/utils/headerValue.ts'
import { ACCOUNT_CHANNELS } from '../../src/main/providers/accountChannels/catalogue.ts'

/**
 * Node 自己的响应头校验规则（`lib/_http_common.js` 的 `headerCharRegex`）：
 * 值里出现除 `\t` 以外的控制字符、或任何 `> 0xFF` 的字符时，`setHeader` 抛
 * `ERR_INVALID_CHAR`，错误文本正是
 * `Invalid character in header content ["X-ModelPort-Route"]`。
 * 这里把它当 oracle：出问题的原始值必须被判非法，编码后的值必须合法。
 */
const NODE_HEADER_CHAR = /[^\t\x20-\x7e\x80-\xff]/
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

test('ASCII only values pass through untouched', () => {
  for (const value of ['glm-5.2 (Zhipu)', 'qoder/dfmodel', 'MiniMax Code', '', ' ']) {
    assert.equal(toHeaderValue(value), value)
  }
})

test('the auto route header is unchanged when the provider name is ASCII', () => {
  assert.equal(routeHeaderValue('glm-5.2', 'Zhipu'), 'glm-5.2 (Zhipu)')
})

test('a Chinese provider name no longer produces an illegal header value', () => {
  // 线上 500 的那一行：auto 命中 TRAE 渠道时 `X-ModelPort-Route` =
  // `实际模型 (供应商名)`，供应商名 `TRAE (字节)` 带中文，Node 写头时直接抛
  // ERR_INVALID_CHAR，被路由的 catch 兜成 500 internal_error。
  const raw = 'TRAE/deepseek-v4 (TRAE (字节))'
  assert.match(raw, NODE_HEADER_CHAR, '前置条件：未编码的值必须是非法的头值')

  const value = routeHeaderValue('TRAE/deepseek-v4', 'TRAE (字节)')
  assert.doesNotMatch(value, NODE_HEADER_CHAR)
  assert.match(value, PRINTABLE_ASCII)
  // 只编码非 ASCII 片段：模型 id、括号、空格仍然一眼可读
  assert.ok(value.startsWith('TRAE/deepseek-v4 (TRAE ('), value)
  assert.ok(value.includes('%E5%AD%97%E8%8A%82'), value) // 字节
})

test('every shipped account-channel name yields a legal header value', () => {
  for (const channel of ACCOUNT_CHANNELS) {
    const raw = `${channel.id}/some-model (${channel.name})`
    const value = routeHeaderValue(`${channel.id}/some-model`, channel.name)

    if (!NODE_HEADER_CHAR.test(raw)) {
      // 纯 ASCII 的渠道（Qoder / MiniMax Code / Gemini）不应被改写
      assert.equal(value, raw, channel.id)
      continue
    }

    assert.match(value, PRINTABLE_ASCII, channel.id)
    assert.doesNotMatch(value, NODE_HEADER_CHAR, channel.id)
    assert.ok(value.startsWith(`${channel.id}/some-model (`), channel.id)
  }
})

test('encoded values decode back to the original text', () => {
  for (const text of ['TRAE (字节)', 'Qoder (中国版)', 'Gemini 🚀', '100% (测试)', 'a→b']) {
    assert.equal(decodeURIComponent(toHeaderValue(text)), text)
  }
})

test('control characters are neutralized instead of reaching the wire', () => {
  const value = toHeaderValue('evil\r\nX-ModelPort-Route: injected')
  assert.match(value, PRINTABLE_ASCII)
  assert.doesNotMatch(value, /[\r\n]/)
  assert.equal(value, 'evil%0D%0AX-ModelPort-Route: injected')
})

test('a lone surrogate is replaced instead of making encoding throw', () => {
  const value = toHeaderValue('bad\uD800tail')
  assert.match(value, PRINTABLE_ASCII)
  assert.equal(value, 'bad%EF%BF%BDtail')
})

test('non-string and empty inputs are coerced safely', () => {
  assert.equal(toHeaderValue(undefined), '')
  assert.equal(toHeaderValue(null), '')
  assert.equal(toHeaderValue(42), '42')
})

/**
 * 纯函数测通了，但路由里若有人改回裸模板字符串，线上照样 500。这里钉住调用点：
 * 两条 chat 路由都必须经 `routeHeaderValue`，不许出现旧的
 * `` `${actualModel} (${provider.name})` ``。
 */
test('both chat routes write the auto winner through the shared helper', () => {
  for (const file of ['src/main/proxy/routes/chat.ts', 'src/main/proxy/routes/completions.ts']) {
    const source = readFileSync(file, 'utf-8')
    assert.match(
      source,
      /ctx\.set\('X-ModelPort-Route', routeHeaderValue\(actualModel, provider\.name\)\)/,
      file
    )
    assert.ok(
      !source.includes('`${actualModel} (${provider.name})`'),
      `${file} must not interpolate the route header raw`
    )
  }
})
