import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import type { ChatMessage } from '../../src/main/proxy/types.ts'
import {
  recordConversationTurn,
  readSurvivorshipStats,
  resetSurvivorship,
  recordConversationTurnForRequest,
  takeConversationTurn,
} from '../../src/main/proxy/compression/survivorship.ts'

/** A request whose conversation key is stable for `conversation` and varies by index. */
function turn(conversation: number, extraTurns = 0): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: `You are a coding agent. session ${conversation}` },
    { role: 'user', content: `task ${conversation}` },
  ]
  for (let index = 0; index < extraTurns; index += 1) {
    messages.push({ role: 'assistant', content: `working ${index}` })
    messages.push({ role: 'tool', content: `result ${index} ${'x'.repeat(200)}` })
  }
  return messages
}

const HOUR = 60 * 60 * 1000

beforeEach(() => {
  resetSurvivorship()
})

test('a single-turn conversation yields no survivorship evidence', () => {
  const now = 1000
  recordConversationTurn(turn(1), now)

  const stats = readSurvivorshipStats(now)
  assert.equal(stats.requests, 1)
  assert.equal(stats.conversations, 1)
  assert.equal(stats.multiTurnConversations, 0)
  // Nothing finished, so no average exists yet — null, not zero.
  assert.equal(stats.meanRemainingTurns, null)
  assert.equal(stats.meanTurnsPerConversation, null)
})

test('the same conversation is attributed to the same key across turns', () => {
  const now = 1000
  const first = recordConversationTurn(turn(1), now)
  const second = recordConversationTurn(turn(1, 1), now + 1000)
  const third = recordConversationTurn(turn(1, 2), now + 2000)

  assert.equal(first.turn, 1)
  assert.equal(second.turn, 2)
  assert.equal(third.turn, 3)
  assert.equal(first.key, second.key)
  assert.equal(second.key, third.key)

  const stats = readSurvivorshipStats(now + 2000)
  assert.equal(stats.conversations, 1)
  assert.equal(stats.multiTurnConversations, 1)
})

test('different conversations get different keys', () => {
  const now = 1000
  const a = recordConversationTurn(turn(1), now)
  const b = recordConversationTurn(turn(2), now)

  assert.notEqual(a.key, b.key)

  const stats = readSurvivorshipStats(now)
  assert.equal(stats.conversations, 2)
})

test('an idle conversation is finished and contributes remaining-turn samples', () => {
  const start = 1000
  // A three-turn conversation, then nothing for over an hour.
  recordConversationTurn(turn(1), start)
  recordConversationTurn(turn(1, 1), start + 1000)
  recordConversationTurn(turn(1, 2), start + 2000)

  const later = start + 2 * HOUR
  const stats = readSurvivorshipStats(later)

  // Expired, so it no longer occupies the live table...
  assert.equal(stats.conversations, 0)
  assert.equal(stats.finishedConversations, 1)
  // ...but ONE finished conversation is not yet an average: `mean*` requires at
  // least 5 samples, so both stay null rather than reporting a single sample as
  // if it were representative.
  assert.equal(stats.meanTurnsPerConversation, null)
  assert.equal(stats.meanRemainingTurns, null)
})

test('remaining turns are what actually followed, not what was hoped for', () => {
  const start = 1000
  // One conversation of exactly 4 turns: after turn 1 → 3 remained, turn 2 → 2,
  // turn 3 → 1, turn 4 → 0 (not sampled).
  for (let index = 0; index < 4; index += 1) {
    recordConversationTurn(turn(1, index), start + index * 1000)
  }

  // Add four more conversations of the same length so the mean clears the
  // 5-sample floor (5 lifetime samples, 15 remaining samples).
  for (let conversation = 2; conversation <= 5; conversation += 1) {
    for (let index = 0; index < 4; index += 1) {
      recordConversationTurn(turn(conversation, index), start + index * 1000)
    }
  }

  const stats = readSurvivorshipStats(start + 2 * HOUR)
  assert.equal(stats.finishedConversations, 5)
  assert.equal(stats.meanTurnsPerConversation, 4)
  // Each 4-turn conversation yields remaining samples [3, 2, 1] → mean 2.
  assert.equal(stats.meanRemainingTurns, 2)
})

test('the cap evicts the least recently seen and reports it', () => {
  const now = 1000
  // 500 conversations fill the table.
  for (let conversation = 0; conversation < 500; conversation += 1) {
    recordConversationTurn(turn(conversation), now + conversation)
  }

  const statsBefore = readSurvivorshipStats(now + 500)
  assert.equal(statsBefore.conversations, 500)
  assert.equal(statsBefore.evictedConversations, 0)

  // One more forces an eviction.
  recordConversationTurn(turn(999), now + 600)
  const statsAfter = readSurvivorshipStats(now + 600)
  assert.equal(statsAfter.conversations, 500)
  assert.equal(statsAfter.evictedConversations, 1)
  // An evicted conversation's lifetime was recorded before it was dropped, so the
  // report never silently loses coverage.
  assert.equal(statsAfter.finishedConversations, 1)
})

test('an unusable request is attributed nowhere but still costs nothing', () => {
  // No system prompt and no user message → no conversation key.
  const messages: ChatMessage[] = [{ role: 'assistant', content: 'hello' }]
  const result = recordConversationTurn(messages)

  assert.equal(result.key, undefined)
  assert.equal(result.turn, 0)

  const stats = readSurvivorshipStats()
  assert.equal(stats.conversations, 0)
})

test('a malformed message cannot throw out of the tracker', () => {
  const messages = [{ role: 'user', content: undefined }] as unknown as ChatMessage[]
  assert.doesNotThrow(() => recordConversationTurn(messages))
})

test('the observation never mutates the messages it reads', () => {
  const messages = turn(1, 3)
  const before = JSON.stringify(messages)

  recordConversationTurn(messages)

  assert.equal(JSON.stringify(messages), before)
})

test('the per-request turn handoff is single-use', () => {
  recordConversationTurnForRequest('req-1', 3)

  assert.equal(takeConversationTurn('req-1'), 3)
  // A second read must not repeat the value into a retried log row.
  assert.equal(takeConversationTurn('req-1'), undefined)
  assert.equal(takeConversationTurn('req-unknown'), undefined)
})
