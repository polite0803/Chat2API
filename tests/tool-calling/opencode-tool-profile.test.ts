import { test } from 'node:test'
import assert from 'node:assert/strict'

import { getProviderToolProfile } from '../../src/main/proxy/toolCalling/providerProfiles.ts'
import { buildToolCallingRuntimePlan } from '../../src/main/proxy/toolCalling/runtimePlan.ts'
import type { ToolCallingConfig } from '../../src/shared/toolCalling.ts'

const config = {
  enabled: true,
  mode: 'auto',
} as unknown as ToolCallingConfig

const clientRequest = {
  clientAdapterId: 'openai',
  tools: [{ name: 'get_weather', description: 'weather', parameters: { type: 'object' } }],
  toolChoice: { mode: 'auto' as const, forcedName: undefined },
  toolSource: 'native' as const,
  parallelToolCalls: true,
}

test('OpenCode is marked as translating tools itself', () => {
  const profile = getProviderToolProfile('opencode')
  assert.equal(profile.handlesToolsItself, true)
  assert.equal(profile.managedSupport, false)
  assert.equal(profile.supportsNativeTools, true)
})

test('the managed layer stands down for a provider that handles tools itself', () => {
  const plan = buildToolCallingRuntimePlan({
    providerId: 'opencode',
    actualModel: 'glm-5.3-flash-free',
    model: 'glm-5.3-flash-free',
    config,
    clientRequest,
  })

  assert.equal(plan.mode, 'disabled')
  assert.equal(plan.shouldInjectPrompt, false, 'no prompt injection: the envelope protocol is the contract')
  assert.equal(plan.shouldParseResponse, false, 'no response parsing: the bridge already returned tool calls')
  assert.equal(plan.diagnostics.reason, 'provider_handles_tools')
  assert.deepEqual(plan.tools.map(tool => tool.name), ['get_weather'])
})

test('other providers keep the managed behaviour', () => {
  const plan = buildToolCallingRuntimePlan({
    providerId: 'kimi',
    actualModel: 'kimi-k2',
    model: 'kimi-k2',
    config,
    clientRequest,
  })

  assert.equal(plan.mode, 'managed')
  assert.equal(plan.shouldInjectPrompt, true)
  assert.equal(plan.shouldParseResponse, true)
})
