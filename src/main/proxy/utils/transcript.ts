import type { ChatMessage } from '../types.ts'
import { extractTextContent } from './contentText.ts'
import { getProviderToolProfile } from '../toolCalling/providerProfiles.ts'

/**
 * Flattens a full conversation into one string for providers whose upstream API
 * only accepts a single user message. System turns are expected to be prepended
 * by the caller.
 */
export function renderTranscript(messages: ChatMessage[], providerId: string): string {
  const profile = getProviderToolProfile(providerId)
  const parts: string[] = []

  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'assistant') {
      if (message.tool_calls && message.tool_calls.length > 0) {
        parts.push(
          `Assistant: ${profile.formatAssistantToolCalls(
            message.tool_calls.map((toolCall) => ({
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            }))
          )}`
        )
        continue
      }
      const text = extractTextContent(message.content)
      if (text) parts.push(`Assistant: ${text}`)
      continue
    }

    if (message.role === 'tool') {
      parts.push(
        `Tool result: ${profile.formatToolResult({
          toolCallId: message.tool_call_id || '',
          content: extractTextContent(message.content),
        })}`
      )
      continue
    }

    const text = extractTextContent(message.content)
    if (text) parts.push(`User: ${text}`)
  }

  return parts.join('\n\n')
}
