/**
 * Conversation-lifetime observation — OBSERVATION ONLY.
 *
 * Answers one question that `net_mutation_gain` cannot be built without: how many
 * more turns will a conversation actually see after this one?
 *
 * That number is the `expected_reads` term in the budget
 *
 *     gain = expected_reads × foldable_tokens × read_price
 *          − cached_suffix_tokens × write_price_delta
 *
 * and it is unknowable at the moment of a request. So it is *learned*: every
 * request is attributed to a conversation, and when that conversation's last
 * observed turn is known, the earlier turns' "how many remained" becomes fact.
 *
 * Three properties, same discipline as `duplication.ts`:
 *
 * 1. **It never changes a request.** Nothing is returned that a caller could
 *    forward; the only consumer is a management endpoint and a log field.
 * 2. **Cheap on single-turn traffic.** Attribution is one map update per request.
 *    The per-conversation history is bounded, and a conversation that is only
 *    ever seen once contributes nothing.
 * 3. **Bounded memory with explicit eviction.** A long-running proxy sees unbounded
 *    conversations; the table is capped and evicts the least recently seen, and
 *    the eviction count is reported so a summary never silently understates.
 *
 * Two modelling limits are deliberate and must stay visible where the numbers are
 * read, because both would otherwise inflate the estimate:
 *
 * - a conversation's "end" is only observable as *the last request we happened to
 *   see*. A conversation that keeps going after the window closes looks finished,
 *   so its surviving-turn counts are LOWER bounds.
 * - a conversation key is `system + first user message`. Two unrelated sessions
 *   that share both are indistinguishable — the same collision the router's
 *   sticky hint already lives with.
 */

import type { ChatMessage } from '../types'
import { conversationKey } from '../autoRouting.ts'
import type { ChatCompletionRequest } from '../types'

/** Conversations tracked concurrently. */
const MAX_CONVERSATIONS = 500
/** Turns remembered per conversation (only the recent ones matter). */
const MAX_TURNS_PER_CONVERSATION = 64
/** A conversation idle this long is treated as finished. */
const CONVERSATION_IDLE_MS = 60 * 60 * 1000
/** Below this many finished conversations, an average is not reported. */
const MIN_SAMPLES_FOR_AVERAGE = 5

interface ConversationRecord {
  /** Monotonic turn ordinals, oldest first, trimmed to the per-conversation cap. */
  turns: number[]
  /** Wall clock of the newest observed turn. */
  lastSeenMs: number
}

export interface SurvivorshipStats {
  /** Total requests attributed to a conversation. */
  requests: number
  /** Conversations currently tracked. */
  conversations: number
  /** Conversations with at least two observed turns. */
  multiTurnConversations: number
  /**
   * Finished conversations (idle past the horizon, or evicted) whose lifetime is
   * therefore known, and the mean number of turns they lasted.
   */
  finishedConversations: number
  meanTurnsPerConversation: number | null
  /**
   * Mean number of turns that remained after a turn — the `expected_reads` input.
   *
   * `null` until enough conversations have finished to mean anything. This is the
   * single number the gain budget needs.
   */
  meanRemainingTurns: number | null
  /** Conversations dropped by the cap, so a summary can flag loss of coverage. */
  evictedConversations: number
}

const conversations = new Map<string, ConversationRecord>()
let requestsAttributed = 0
/** Remaining-turn samples collected from conversations that ended. */
const remainingSamples: number[] = []
const lifetimeSamples: number[] = []
let evictedConversations = 0

const MAX_SAMPLES = 2000

function rememberSample(list: number[], value: number): void {
  list.push(value)
  if (list.length > MAX_SAMPLES) list.shift()
}

/** Drop conversations idle past the horizon, recording their lifetime first. */
function expireIdle(nowMs: number): void {
  for (const [key, record] of conversations) {
    if (nowMs - record.lastSeenMs < CONVERSATION_IDLE_MS) continue
    finishConversation(record)
    conversations.delete(key)
  }
}

/** Record a finished conversation's lifetime and per-turn remaining counts. */
function finishConversation(record: ConversationRecord): void {
  const turns = record.turns
  if (turns.length === 0) return
  rememberSample(lifetimeSamples, turns.length)
  // For each turn except the last, the number of turns that actually followed.
  for (let index = 0; index < turns.length - 1; index += 1) {
    rememberSample(remainingSamples, turns.length - 1 - index)
  }
}

function mean(list: number[]): number | null {
  if (list.length < MIN_SAMPLES_FOR_AVERAGE) return null
  return list.reduce((sum, value) => sum + value, 0) / list.length
}

/**
 * Attribute one request to a conversation and advance its turn counter.
 *
 * Returns the per-request survivorship figure — how many turns this conversation
 * had already seen — which is what gets logged. The interesting number
 * (`meanRemainingTurns`) can only exist after conversations finish, so it is
 * accumulated here and read from `readSurvivorshipStats`.
 */
export function recordConversationTurn(
  messages: ChatMessage[] | undefined,
  nowMs: number = Date.now()
): { key: string | undefined; turn: number } {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { key: undefined, turn: 0 }
  }

  expireIdle(nowMs)

  let key: string | undefined
  try {
    // `conversationKey` reads only `messages`; the cast keeps this module from
    // having to fabricate a full request (a `model` string would be a lie).
    key = conversationKey({ messages } as ChatCompletionRequest)
  } catch {
    // A malformed message must not break attribution, and must not break the
    // request either — callers treat this as observation only.
    return { key: undefined, turn: 0 }
  }
  if (!key) return { key: undefined, turn: 0 }

  requestsAttributed += 1

  const existing = conversations.get(key)
  if (existing) {
    existing.lastSeenMs = nowMs
    const nextTurn = (existing.turns[existing.turns.length - 1] ?? 0) + 1
    existing.turns.push(nextTurn)
    if (existing.turns.length > MAX_TURNS_PER_CONVERSATION) existing.turns.shift()
    return { key, turn: nextTurn }
  }

  // Evict the least recently seen conversation before growing past the cap.
  if (conversations.size >= MAX_CONVERSATIONS) {
    let oldestKey: string | undefined
    let oldestSeen = Number.POSITIVE_INFINITY
    for (const [candidateKey, record] of conversations) {
      if (record.lastSeenMs < oldestSeen) {
        oldestSeen = record.lastSeenMs
        oldestKey = candidateKey
      }
    }
    if (oldestKey !== undefined) {
      const record = conversations.get(oldestKey)
      if (record) finishConversation(record)
      conversations.delete(oldestKey)
      evictedConversations += 1
    }
  }

  conversations.set(key, { turns: [1], lastSeenMs: nowMs })
  return { key, turn: 1 }
}

/** Read the current survivorship summary. */
export function readSurvivorshipStats(nowMs: number = Date.now()): SurvivorshipStats {
  // `expireIdle` records each finished conversation's lifetime itself, so those
  // are already counted in `lifetimeSamples`. Do NOT add an expiry count on top:
  // that double-counts every conversation that ends by idle timeout.
  expireIdle(nowMs)

  let multiTurn = 0
  for (const record of conversations.values()) {
    if ((record.turns[record.turns.length - 1] ?? 0) >= 2) multiTurn += 1
  }

  return {
    requests: requestsAttributed,
    conversations: conversations.size,
    multiTurnConversations: multiTurn,
    finishedConversations: lifetimeSamples.length,
    meanTurnsPerConversation: mean(lifetimeSamples),
    meanRemainingTurns: mean(remainingSamples),
    evictedConversations,
  }
}

/**
 * Per-request turn handoff, mirroring the duplication report registry.
 *
 * The forwarder computes the turn; the route owns the log row.
 */
const pendingTurns = new Map<string, number>()
const MAX_PENDING_TURNS = 256

export function recordConversationTurnForRequest(requestId: string, turn: number): void {
  if (!requestId) return
  if (pendingTurns.size >= MAX_PENDING_TURNS) {
    const oldest = pendingTurns.keys().next()
    if (!oldest.done) pendingTurns.delete(oldest.value)
  }
  pendingTurns.set(requestId, turn)
}

export function takeConversationTurn(requestId: string): number | undefined {
  const turn = pendingTurns.get(requestId)
  if (turn !== undefined) pendingTurns.delete(requestId)
  return turn
}

/** Reset all state. Tests only — production never wants to forget. */
export function resetSurvivorship(): void {
  conversations.clear()
  remainingSamples.length = 0
  lifetimeSamples.length = 0
  pendingTurns.clear()
  requestsAttributed = 0
  evictedConversations = 0
}
