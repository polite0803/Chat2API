import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ACCOUNT_CHANNELS,
  channelModelName,
  getChannelDefinition,
  isAccountChannelId,
} from '../../src/main/providers/accountChannels/catalogue.ts'

const PACK_INDEX = join(process.cwd(), 'vendor', 'channel-pack', 'src', 'index.ts')

test('the catalogue ships exactly ten channels with unique ids', () => {
  assert.equal(ACCOUNT_CHANNELS.length, 10)
  const ids = new Set<string>()
  for (const channel of ACCOUNT_CHANNELS) {
    assert.equal(ids.has(channel.id), false, `duplicate channel id: ${channel.id}`)
    ids.add(channel.id)
    assert.ok(channel.name.length > 0)
    assert.ok(channel.vendor.length > 0)
  }
})

test('every channel id exists in the vendored pack', () => {
  // 不 import vendor 源码（它会拉到 dsh-llm 等虚拟模块，node --test 里无法解析），
  // 只在源码文本里确认 id 字面量存在 —— 这一条防的就是「目录里加了一个上游没有
  // 的渠道」这种最常见的漂移。
  const source = readFileSync(PACK_INDEX, 'utf8')
  for (const channel of ACCOUNT_CHANNELS) {
    assert.ok(
      source.includes(`'${channel.id}'`),
      `channel ${channel.id} is not registered by vendor/channel-pack/src/index.ts`,
    )
  }
})

test('model names are namespaced by the channel id', () => {
  assert.equal(channelModelName('qoder', 'claude-sonnet-4'), 'qoder/claude-sonnet-4')
  assert.equal(isAccountChannelId('qoder'), true)
  assert.equal(isAccountChannelId('openai'), false)
  assert.equal(getChannelDefinition('qoder')?.name, 'Qoder')
  assert.equal(getChannelDefinition('nope'), undefined)
})
