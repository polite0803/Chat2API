/**
 * Output-side token reduction ("verbosity steering").
 *
 * Everything else in this feature shrinks what we SEND. Output costs money too,
 * and on high-end models it costs several times more per token than input —
 * much of it spent on ceremony: "Great, let me…" preambles, code re-printed
 * straight back, narration of routine tool results.
 *
 * The mechanism is a short, fixed instruction block appended to the tail of the
 * system prompt. Three properties make it safe:
 *
 * 1. **Byte-stable.** For a given level the block text never changes, so the
 *    system prompt (and therefore the provider's cached prefix) stays identical
 *    turn after turn. Editing the wording is a cache-busting change and must be
 *    treated as a version bump, not a tweak.
 * 2. **Idempotent.** The block is delimited by a sentinel; re-applying replaces
 *    it in place instead of stacking a second copy. Level 0 removes it, so
 *    turning the feature off restores the original prompt exactly.
 * 3. **Non-destructive.** Only the system message is touched. User, assistant
 *    and tool messages are never modified — they are the model's evidence, and
 *    the live-zone rules already govern what may be rewritten there.
 *
 * Where the block lands is deliberately not "the very last line the model
 * reads". The managed tool-call layer appends its protocol instructions to the
 * same system message afterwards (`ToolCallingEngine.injectPrompt`), and that is
 * the correct priority: the tool protocol is a hard contract, while this is a
 * style hint. A hint must never outrank a contract.
 */

import type { ChatMessage } from '../types'

export const STEERING_SENTINEL_OPEN = '<modelport_output_shaping>'
export const STEERING_SENTINEL_CLOSE = '</modelport_output_shaping>'

/**
 * Instruction text per level.
 *
 * Levels are cumulative and each one carries the "shorten how you say it, not
 * what you say" guard: terseness must never become a correctness bug by dropping
 * a negation or a constraint. That clause is why level 3 is worded as carefully
 * as it is.
 *
 * These strings are OUR wording (the mechanism is ported; the text is not). They
 * are frozen: any edit changes the cached prefix for every user.
 */
const LEVEL_TEXT: Record<number, string> = {
  1: 'Skip preamble and postamble. Do not announce what you are about to do, and do not recap what you just did. Start with the substance.',
  2: [
    'Skip preamble and postamble. Start with the substance.',
    'Never restate code, file contents, diffs, or tool output that already appears in this conversation — reference them by path and line instead.',
    'After a tool call succeeds, continue without narrating the result.',
  ].join(' '),
  3: [
    'Skip preamble and postamble. Start with the substance.',
    'Never restate code, file contents, diffs, or tool output already present in this conversation — cite the exact path and line, or the symbol; a reference without a location is not a reference.',
    'Give conclusions only. Omit rationale unless asked why.',
    'Prefer the smallest edit over rewriting a whole file.',
    'Keep prose to the minimum needed to be unambiguous.',
    'Never drop anything the task needs to be correct — including negations (not, never, no, only, except) and conditions. Shorten how you say it, not what you say.',
  ].join(' '),
}

/** Highest level that has text. */
export const MAX_VERBOSITY_LEVEL = 3

/** The full delimited block for `level`, or null for level 0. */
export function steeringBlock(level: number): string | null {
  const text = LEVEL_TEXT[level]
  if (!text) return null
  return `${STEERING_SENTINEL_OPEN}\n${text}\n${STEERING_SENTINEL_CLOSE}`
}

/**
 * Replace an existing block in `content`, or append one at the tail.
 *
 * Exported so the sentinel handling can be tested without a message array.
 */
export function replaceOrAppendBlock(content: string, block: string): string {
  const start = content.indexOf(STEERING_SENTINEL_OPEN)
  if (start >= 0) {
    const endMarker = content.indexOf(STEERING_SENTINEL_CLOSE, start)
    const end =
      endMarker < 0 ? content.length : endMarker + STEERING_SENTINEL_CLOSE.length
    const prefix = content.slice(0, start).replace(/\s+$/, '')
    const suffix = content.slice(end).replace(/^\s+/, '')
    return [prefix, block, suffix].filter(part => part.length > 0).join('\n\n')
  }

  const base = content.replace(/\s+$/, '')
  return base.length > 0 ? `${base}\n\n${block}` : block
}

/** Remove a previously applied block, leaving the original prompt behind. */
export function stripBlock(content: string): string {
  const start = content.indexOf(STEERING_SENTINEL_OPEN)
  if (start < 0) return content

  const endMarker = content.indexOf(STEERING_SENTINEL_CLOSE, start)
  const end = endMarker < 0 ? content.length : endMarker + STEERING_SENTINEL_CLOSE.length
  const prefix = content.slice(0, start).replace(/\s+$/, '')
  const suffix = content.slice(end).replace(/^\s+/, '')
  return [prefix, suffix].filter(part => part.length > 0).join('\n\n')
}

/** Index of the last system message, or -1. */
function lastSystemIndex(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'system') return index
  }
  return -1
}

export interface VerbositySteeringResult {
  messages: ChatMessage[]
  /** True when the array or a message actually changed. */
  changed: boolean
}

/**
 * Apply (or remove) the steering block on one request's messages.
 *
 * Returns the SAME array reference when nothing changed, so callers can rely on
 * reference equality to detect a no-op — the same contract the compression
 * facade uses.
 */
export function applyVerbositySteering(
  messages: ChatMessage[] | undefined,
  level: number
): VerbositySteeringResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: messages ?? [], changed: false }
  }

  const block = steeringBlock(level)

  // Level 0 (or an unknown level) means "off": remove anything we added before.
  if (!block) {
    if (level !== 0) return { messages, changed: false }
    const index = lastSystemIndex(messages)
    if (index < 0) return { messages, changed: false }
    const message = messages[index]
    if (typeof message.content !== 'string') return { messages, changed: false }
    if (message.content.indexOf(STEERING_SENTINEL_OPEN) < 0) {
      return { messages, changed: false }
    }
    const stripped = stripBlock(message.content)
    if (stripped === message.content) return { messages, changed: false }
    const next = messages.slice()
    next[index] = { ...message, content: stripped }
    return { messages: next, changed: true }
  }

  const index = lastSystemIndex(messages)

  // No system message at all: create one carrying just the block, at the front
  // so the conversation's own turns keep their order.
  if (index < 0) {
    return {
      messages: [{ role: 'system', content: block }, ...messages],
      changed: true,
    }
  }

  const message = messages[index]

  if (typeof message.content === 'string') {
    const nextContent = replaceOrAppendBlock(message.content, block)
    if (nextContent === message.content) return { messages, changed: false }
    const next = messages.slice()
    next[index] = { ...message, content: nextContent }
    return { messages: next, changed: true }
  }

  // Multimodal system content: append a text part at the tail. An existing
  // identical part means it is already applied.
  if (Array.isArray(message.content)) {
    const lastPart = message.content[message.content.length - 1]
    if (lastPart && lastPart.type === 'text' && lastPart.text === block) {
      return { messages, changed: false }
    }
    const parts = message.content.slice()
    // Drop a stale block from an earlier level, wherever it sits.
    const cleaned = parts.filter(
      part => !(part.type === 'text' && typeof part.text === 'string' && part.text.indexOf(STEERING_SENTINEL_OPEN) >= 0)
    )
    cleaned.push({ type: 'text', text: block })
    const next = messages.slice()
    next[index] = { ...message, content: cleaned }
    return { messages: next, changed: true }
  }

  // `content: null` on a system message: nothing to anchor to, leave it alone.
  return { messages, changed: false }
}
