import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test('重试循环把失败的状态码带给调用方，而不是退化成 500', () => {
  const source = readFileSync(join(root, 'src/main/proxy/forwarder.ts'), 'utf8')

  // 丢状态码 ⇒ mapUpstreamError(undefined) ⇒ 500：客户端看到"服务器错误"，
  // 而不是"被限流 / 这个请求有问题"，也就不会退避
  assert.match(source, /lastStatus = result\.status/)
  assert.match(source, /return \{\s*success: false,\s*\/\/[^\n]*\n\s*status: lastStatus,[\s\S]{0,200}?error: lastError/)
})

test('429 不再原样重试', () => {
  const source = readFileSync(join(root, 'src/main/proxy/forwarder.ts'), 'utf8')

  // 同一个账号隔 5 秒重打一次对限流没用，只会把配额和等待一起赔进去
  assert.match(source, /if \(result\.status && result\.status < 500\) \{\s*break/)
  assert.doesNotMatch(source, /result\.status < 500 && result\.status !== 429/)
})
