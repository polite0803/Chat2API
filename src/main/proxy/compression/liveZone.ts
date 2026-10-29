/**
 * Live-zone selection for OpenAI-shaped chat requests.
 *
 * This is the single most important correctness rule in the whole feature, so
 * it lives in its own module with its own tests.
 *
 * A proxy sees the FULL history on every turn. Rewriting any of it changes
 * bytes the provider has already cached, which turns a token saving into a net
 * cost: cache writes cost ~1.25x (5-minute tier) and reads ~0.1x, so mutating a
 * `dT`-token prefix that still has `S` tokens of cached suffix behind it only
 * breaks even after roughly `11.5 * S / dT` re-reads. History is long, so it
 * never does.
 *
 * Therefore only the "live zone" — the newest bytes the model is about to
 * answer against — is ever rewritten. For the OpenAI chat shape that is
 * (headroom `live_zone.rs:2238-2493`):
 *
 *   - the LATEST `role: "tool"` message's string content, and
 *   - the LATEST `role: "user"` message's text content.
 *
 * Everything else is frozen: earlier tool/user messages, every `assistant`
 * message (the next response continues from it, so it is part of the hot
 * cache), and every `system` message. `tools` / `tool_choice` are never read or
 * written here.
 *
 * Because this proxy rebuilds the upstream body from the request object rather
 * than re-serializing a raw byte buffer, "frozen" is stronger than in headroom:
 * untouched messages keep their object identity, so their serialized form
 * cannot drift.
 */

import type { ChatMessage } from '../types.ts'

export type LiveZoneKind = 'tool' | 'user'

export interface LiveZoneTarget {
  messageIndex: number
  kind: LiveZoneKind
  /** Index into `content` when it is an array of parts. */
  partIndex?: number
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * The text a `user`-role message offers for compression.
 *
 * Multimodal messages are common: only `text` parts are eligible, `image_url`
 * parts are left alone. When `content` is a bare string there is a single
 * implicit part.
 */
function userTextParts(message: ChatMessage): Array<{ text: string; partIndex?: number }> {
  if (isNonEmptyString(message.content)) {
    return [{ text: message.content }]
  }
  if (!Array.isArray(message.content)) return []

  const parts: Array<{ text: string; partIndex?: number }> = []
  message.content.forEach((part, partIndex) => {
    if (part && part.type === 'text' && isNonEmptyString(part.text)) {
      parts.push({ text: part.text, partIndex })
    }
  })
  return parts
}

/**
 * Pick every rewritable text slot in one request.
 *
 * Eligible: the latest `role: "tool"` message and the latest `role: "user"`
 * message — but only when each sits **after the last `assistant` message**.
 *
 * That extra condition is deliberately stricter than upstream. Headroom selects
 * the latest tool and the latest user as two independent indices, which can pick
 * a user message that an assistant turn has already replied to. Rewriting that
 * message mutates bytes with a cached suffix behind them — exactly the mutation
 * the cache economics forbid — so an already-answered user message is frozen
 * here like any other history. The tool result is unaffected in practice: it
 * always follows the assistant turn that requested it.
 *
 * Returns `[]` when nothing is safely rewritable, which the caller must treat
 * as "forward verbatim" rather than "compress nothing this time".
 */
export function pickLiveZone(messages: ChatMessage[] | undefined): LiveZoneTarget[] {
  if (!Array.isArray(messages) || messages.length === 0) return []

  let lastAssistantIndex = -1
  let lastToolIndex = -1
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.role
    if (lastAssistantIndex < 0 && role === 'assistant') lastAssistantIndex = index
    if (lastToolIndex < 0 && role === 'tool') lastToolIndex = index
    if (lastUserIndex < 0 && role === 'user') lastUserIndex = index
    if (lastAssistantIndex >= 0 && lastToolIndex >= 0 && lastUserIndex >= 0) break
  }

  const targets: LiveZoneTarget[] = []

  // The latest tool result is where tool output lives — the highest-value
  // target by far, since a single search/log payload dominates the turn.
  // `> lastAssistantIndex` keeps a tool result that an assistant turn already
  // consumed out of the rewrite set: it now has a cached suffix behind it.
  if (lastToolIndex >= 0 && lastToolIndex > lastAssistantIndex) {
    const message = messages[lastToolIndex]
    if (isNonEmptyString(message.content)) {
      targets.push({ messageIndex: lastToolIndex, kind: 'tool' })
    }
  }

  // The latest user message is the current prompt only when no assistant turn
  // has answered it yet.
  if (lastUserIndex >= 0 && lastUserIndex > lastAssistantIndex) {
    for (const part of userTextParts(messages[lastUserIndex])) {
      targets.push({ messageIndex: lastUserIndex, kind: 'user', partIndex: part.partIndex })
    }
  }

  return targets
}

/** Read the current text for a target, or undefined when it no longer matches. */
export function readLiveZoneText(
  messages: ChatMessage[],
  target: LiveZoneTarget
): string | undefined {
  const message = messages[target.messageIndex]
  if (!message) return undefined

  if (target.kind === 'tool') {
    return isNonEmptyString(message.content) ? message.content : undefined
  }

  if (target.partIndex === undefined) {
    return isNonEmptyString(message.content) ? message.content : undefined
  }

  if (!Array.isArray(message.content)) return undefined
  const part = message.content[target.partIndex]
  return part && part.type === 'text' && isNonEmptyString(part.text) ? part.text : undefined
}

/**
 * Return a new messages array with exactly one target's text replaced.
 *
 * Immutability matters twice here: it is the repository rule, and it is what
 * guarantees every non-target message serializes identically to before.
 */
export function replaceLiveZoneText(
  messages: ChatMessage[],
  target: LiveZoneTarget,
  text: string
): ChatMessage[] {
  const next = messages.slice()
  const message = messages[target.messageIndex]
  if (!message) return messages

  if (target.partIndex === undefined) {
    next[target.messageIndex] = { ...message, content: text }
    return next
  }

  if (!Array.isArray(message.content)) return messages
  const parts = message.content.slice()
  const part = parts[target.partIndex]
  if (!part) return messages
  parts[target.partIndex] = { ...part, text }
  next[target.messageIndex] = { ...message, content: parts }
  return next
}
