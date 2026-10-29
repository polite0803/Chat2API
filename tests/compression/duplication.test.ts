import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { ChatMessage } from '../../src/main/proxy/types.ts'
import {
  measureCrossTurnDuplication,
  normalizeLineKey,
} from '../../src/main/proxy/compression/duplication.ts'

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content }
}

/** A block of `lines` distinct numbered source lines, so the text is realistic. */
function sourceBlock(lines: number, prefix = 'src'): string {
  return Array.from({ length: lines }, (_, index) => `export function ${prefix}${index}() { return ${index}; }`).join('\n')
}

test('a single-turn request is measured at zero cost and reports nothing', () => {
  // This is the shape of every request in the current traffic: system + user,
  // no history. The measurement must not claim duplication it cannot see.
  const messages: ChatMessage[] = [
    msg('system', 'You are a coding agent.'),
    msg('user', 'refactor this file'),
  ]

  const stats = measureCrossTurnDuplication(messages)
  assert.equal(stats.blocks, 0)
  assert.equal(stats.duplicatedChars, 0)
  assert.equal(stats.runs, 0)
  assert.equal(stats.truncated, false)
})

test('one large block is not compared with itself', () => {
  const messages: ChatMessage[] = [msg('system', sourceBlock(200))]
  const stats = measureCrossTurnDuplication(messages)
  assert.equal(stats.blocks, 0)
  assert.equal(stats.duplicatedChars, 0)
})

test('a block repeated verbatim in a later message is counted once', () => {
  const block = sourceBlock(120)
  const messages: ChatMessage[] = [
    msg('system', 'You are a coding agent.'),
    msg('tool', block),
    msg('assistant', 'reading it again'),
    msg('tool', block),
  ]

  const stats = measureCrossTurnDuplication(messages)
  assert.ok(stats.duplicatedChars > 0)
  assert.equal(stats.runs, 1)
  // Every line of the second copy is duplicated, so the count is the block.
  assert.ok(stats.duplicatedChars >= block.length - 2)
  assert.ok(stats.duplicatedChars <= block.length + 8)
})

test('the earliest copy is never the one folded', () => {
  // Three identical copies: the first is the anchor, so only two can fold.
  const block = sourceBlock(120)
  const messages: ChatMessage[] = [
    msg('tool', block),
    msg('tool', block),
    msg('tool', block),
  ]

  const stats = measureCrossTurnDuplication(messages)
  assert.ok(stats.duplicatedChars < block.length * 3)
  assert.ok(stats.duplicatedChars >= block.length * 2 - 8)
})

test('a uniform line-number shift still matches', () => {
  // Re-reading a file after an edit shifted every line number; the text is
  // identical, so this is still a verbatim duplicate.
  const body = Array.from({ length: 80 }, (_, index) => `const value${index} = compute(${index});`)
  const first = body.map((line, index) => `${index + 1}: ${line}`).join('\n')
  const second = body.map((line, index) => `${index + 11}: ${line}`).join('\n')

  const stats = measureCrossTurnDuplication([msg('tool', first), msg('tool', second)])
  assert.equal(stats.runs, 1)
  assert.ok(stats.duplicatedChars > 0)
})

test('lines that merely start alike are not called a duplicate', () => {
  // Two runs of 2 lines each: below the 3-line minimum.
  const a = ['export function alpha() {', '  return 1;', '}', 'unique tail a'].join('\n')
  const b = ['export function alpha() {', '  return 1;', '}', 'unique tail b'].join('\n')

  const stats = measureCrossTurnDuplication([msg('tool', a), msg('tool', b)])
  assert.equal(stats.runs, 0)
  assert.equal(stats.duplicatedChars, 0)
})

test('a run shorter than the char floor is ignored', () => {
  // 3 identical short lines: clears the line minimum but not 40 characters.
  const a = ['a', 'b', 'c'].join('\n')
  const b = ['a', 'b', 'c'].join('\n')

  const stats = measureCrossTurnDuplication([msg('tool', a), msg('tool', b)])
  assert.equal(stats.runs, 0)
})

test('mixed multimodal content is measured from its text parts', () => {
  const block = sourceBlock(120)
  const messages: ChatMessage[] = [
    msg('tool', block),
    { role: 'tool', content: [{ type: 'text', text: block }] } as ChatMessage,
  ]

  const stats = measureCrossTurnDuplication(messages)
  assert.ok(stats.duplicatedChars > 0)
})

test('normalisation strips line numbers, bullets and re-wrapping', () => {
  assert.equal(normalizeLineKey('  42: const x = 1;'), 'const x = 1;')
  // Column output and `git diff` markers are also stripped.
  assert.equal(normalizeLineKey('42\tconst x = 1;'), 'const x = 1;')
  assert.equal(normalizeLineKey('> const x = 1;'), 'const x = 1;')
  assert.equal(normalizeLineKey('| const   x   =   1;'), 'const x = 1;')
  assert.equal(normalizeLineKey('const x = 1;\r'), 'const x = 1;')
})

test('a bare number followed by a space is not treated as a line number', () => {
  // Deliberate: stripping these would make "1 apple" and "2 apples" collapse to
  // the same key, and two unrelated prose lines would count as a duplicate.
  assert.equal(normalizeLineKey('1 apple'), '1 apple')
  assert.equal(normalizeLineKey('2 apples'), '2 apples')
  assert.notEqual(normalizeLineKey('1 apple'), normalizeLineKey('2 apples'))
})

test('the measurement never mutates the messages it reads', () => {
  // Observation must be physically incapable of changing request bytes.
  const block = sourceBlock(120)
  const messages: ChatMessage[] = [msg('tool', block), msg('tool', block)]
  const before = JSON.stringify(messages)

  measureCrossTurnDuplication(messages)

  assert.equal(JSON.stringify(messages), before)
})

test('the cap marks the result truncated rather than lying about coverage', () => {
  // 40 blocks × 8 KB each blows past the 256 KB scan cap.
  const big = sourceBlock(400)
  const messages: ChatMessage[] = Array.from({ length: 40 }, () => msg('tool', big))

  const stats = measureCrossTurnDuplication(messages)
  assert.equal(stats.truncated, true)
  assert.ok(stats.scannedChars <= 256 * 1024)
})

test('non-text and empty content is skipped without throwing', () => {
  const messages: ChatMessage[] = [
    { role: 'tool', content: null } as ChatMessage,
    msg('tool', sourceBlock(120)),
    msg('tool', sourceBlock(120, 'other')),
  ]

  const stats = measureCrossTurnDuplication(messages)
  assert.equal(typeof stats.duplicatedChars, 'number')
})
