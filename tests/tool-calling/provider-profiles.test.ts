import test from 'node:test'
import assert from 'node:assert/strict'
import { getProviderToolProfile } from '../../src/main/proxy/toolCalling/providerProfiles.ts'

const calls = [
  { id: 'call_1', name: 'default_api:read_file', arguments: '{"filePath":"/tmp/a"}' },
]

test('first-version providers use managed prompt and managed xml by default', () => {
  for (const providerId of ['deepseek', 'kimi', 'glm', 'qwen']) {
    const profile = getProviderToolProfile(providerId)

    assert.equal(profile.managedSupport, true)
    assert.equal(profile.supportsNativeTools, false)
    assert.equal(profile.preferredManagedProtocol, 'managed_xml')
  }
})

test('priority providers format tool history with the ModelPort XML protocol', () => {
  for (const providerId of ['deepseek', 'kimi', 'glm', 'qwen']) {
    const profile = getProviderToolProfile(providerId)

    assert.equal(
      profile.formatAssistantToolCalls(calls),
      '<|MODELPORT|tool_calls><|MODELPORT|invoke name="default_api:read_file" tool_call_id="call_1"><|MODELPORT|parameter name="filePath"><![CDATA[/tmp/a]]></|MODELPORT|parameter></|MODELPORT|invoke></|MODELPORT|tool_calls>',
    )
    assert.equal(
      profile.formatToolResult({ toolCallId: 'call_1', content: 'file body' }),
      '<|MODELPORT|tool_result tool_call_id="call_1"><![CDATA[file body]]></|MODELPORT|tool_result>',
    )
  }
})
