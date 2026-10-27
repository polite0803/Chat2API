import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PROBE_TTL,
  ProbeCache,
  classifyProbe,
  classifyProbeFailure,
  isFresh,
  probeCachePath,
  probeModel,
  PROBE_TOOL_NAME,
} from '../../src/main/opencode/probe.ts'
import type { BridgeReply } from '../../src/main/opencode/bridge.ts'

const reply = (text = '', toolCalls: BridgeReply['toolCalls'] = []): BridgeReply => ({
  text,
  toolCalls,
  tokens: null,
  firstByteMs: 0,
  totalMs: 0,
})

test('a model that calls the probe tool is tool-capable', () => {
  const result = classifyProbe(reply('', [{ name: PROBE_TOOL_NAME, arguments: { value: 'probe' } }]))
  assert.equal(result.status, 'tool-capable')
  assert.equal(result.reason, 'envelope_with_tool_call')
})

test('a model that only answers is chat-only', () => {
  const result = classifyProbe(reply('I cannot use tools'))
  assert.equal(result.status, 'chat-only')
  assert.equal(result.reason, 'envelope_without_tool_call')
})

test('failures are classified by what actually happened', () => {
  assert.equal(classifyProbeFailure(new Error('native_tool_activity: the model tried to use bash')).reason, 'native_tool_activity')
  assert.equal(classifyProbeFailure(new Error('OpenCode replied HTTP 429: FreeUsageLimitError')).reason, 'rate_limited')
  assert.equal(classifyProbeFailure(new Error('OpenCode replied HTTP 404')).reason, 'model_unavailable')
  assert.equal(classifyProbeFailure(new Error('This operation was aborted')).reason, 'timeout')
  assert.equal(classifyProbeFailure(new Error('boom')).reason, 'failed')
})

test('cache freshness follows the per-reason ttl', () => {
  const now = Date.now()
  const success = { status: 'tool-capable' as const, reason: 'envelope_with_tool_call' as const, checkedAt: now }
  assert.equal(isFresh(success, now), true)
  assert.equal(isFresh(success, now + PROBE_TTL.envelope_with_tool_call - 1000), true)
  assert.equal(isFresh(success, now + PROBE_TTL.envelope_with_tool_call + 1000), false)

  const limited = { status: 'chat-only' as const, reason: 'rate_limited' as const, checkedAt: now }
  assert.equal(isFresh(limited, now + PROBE_TTL.rate_limited - 1000), true)
  assert.equal(isFresh(limited, now + PROBE_TTL.rate_limited + 1000), false)
})

test('the cache survives a restart and drops stale entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-probe-'))
  const file = probeCachePath(dir)
  try {
    const first = new ProbeCache(file)
    first.set('glm-5.3-flash-free', {
      status: 'chat-only',
      reason: 'envelope_without_tool_call',
      checkedAt: Date.now(),
    })

    const second = new ProbeCache(file)
    assert.equal(second.get('glm-5.3-flash-free')?.status, 'chat-only')

    // 过期的条目不返回
    const stale = new ProbeCache(file)
    stale.set('old-model', {
      status: 'tool-capable',
      reason: 'envelope_with_tool_call',
      checkedAt: Date.now() - PROBE_TTL.envelope_with_tool_call - 1000,
    })
    assert.equal(stale.get('old-model'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probing a model that throws yields a chat-only verdict, not a crash', async () => {
  const failing = {
    chat: async () => {
      throw new Error('OpenCode replied HTTP 429: FreeUsageLimitError')
    },
  }
  const result = await probeModel(failing as never, 'glm-5.3-flash-free')
  assert.equal(result.status, 'chat-only')
  assert.equal(result.reason, 'rate_limited')
})
