import { test } from 'node:test'
import assert from 'node:assert/strict'

import { crushJsonArray } from '../../src/main/proxy/compression/compressors/smartCrusher.ts'
import { ROW_SENTINEL_KEY, isCcrSentinel } from '../../src/main/proxy/compression/ccr/markers.ts'
/** Stash stub: records what was stashed so the test can assert retrievability. */
function makeStash(): { stash: (original: string, idLength: number) => string | null; stashed: Map<string, string> } {
  const stashed = new Map<string, string>()
  return {
    stashed,
    stash: (original: string, idLength: number) => {
      const id = 'a'.repeat(idLength)
      stashed.set(id, original)
      return id
    },
  }
}

function crush(json: unknown, options: { maxKeptItems?: number; bias?: number } = {}) {
  const { stash, stashed } = makeStash()
  const result = crushJsonArray(JSON.stringify(json), {
    maxKeptItems: options.maxKeptItems ?? 15,
    bias: options.bias ?? 1,
    stash,
  })
  return { result, stashed }
}

/** Rows of a crushed object array, without the sentinel. */
function dataRows(text: string): Record<string, unknown>[] {
  const parsed = JSON.parse(text) as unknown[]
  return parsed.filter((row): row is Record<string, unknown> => !isCcrSentinel(row))
}

test('a redundant array is compressed and keeps an error row', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ id: index, status: 'ok', duration: 10 }))
  rows[67] = { id: 67, status: 'ok', duration: 10, error: 'FATAL: connection reset' }
  rows[68] = { id: 68, status: 'ok', duration: 10, failure: 'timeout after 30s' }

  const { result, stashed } = crush(rows)

  assert.equal(result.changed, true)
  const kept = dataRows(result.text)

  // The two error rows are the whole point of the payload: they must survive.
  const keptIds = kept.map(row => row.id)
  assert.ok(keptIds.includes(67), 'error row 67 must be preserved')
  assert.ok(keptIds.includes(68), 'failure row 68 must be preserved')

  // Compression actually happened.
  assert.ok(kept.length < rows.length)

  // The original is retrievable under the marker's hash.
  assert.ok(result.ccrHash)
  const original = stashed.get(result.ccrHash as string)
  assert.ok(original)
  assert.deepEqual(JSON.parse(original as string), rows)
})

test('the dropped-row sentinel is an object and carries a hash', () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({ id: index, msg: 'same line repeated' }))
  const { result } = crush(rows)

  assert.equal(result.changed, true)
  const parsed = JSON.parse(result.text) as unknown[]
  const sentinel = parsed[parsed.length - 1] as Record<string, string>

  assert.equal(Object.keys(sentinel).length, 1)
  assert.ok(ROW_SENTINEL_KEY in sentinel)
  assert.match(sentinel[ROW_SENTINEL_KEY], /^<<ccr:[a-f0-9]{12} \d+_rows_offloaded>>$/)
})

test('a numeric anomaly beyond 2 sigma is preserved', () => {
  const rows = Array.from({ length: 80 }, (_, index) => ({ id: index, latencyMs: 12 }))
  rows[40] = { id: 40, latencyMs: 9999 }

  const { result } = crush(rows)
  assert.equal(result.changed, true)

  const kept = dataRows(result.text)
  assert.ok(
    kept.some(row => row.id === 40),
    'the 9999ms outlier must be preserved'
  )
})

test('a unique-entity list with no signal is not compressed at all', () => {
  // Every row distinct, nothing marking any of them: sampling would lose
  // information, so `analyzeCrushability` must refuse.
  const rows = Array.from({ length: 40 }, (_, index) => ({
    id: `usr_${Math.random().toString(36).slice(2)}${index}`,
    email: `person-${index}-${'x'.repeat(index + 3)}@example.com`,
    note: `unique memo number ${index} with distinctive wording ${index * 7}`,
  }))

  const { result } = crush(rows)
  assert.equal(result.changed, false)
})

test('a payload below the minimum item count is left alone', () => {
  const { result } = crush([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }])
  assert.equal(result.changed, false)
})

test('non-array JSON and malformed input are left alone', () => {
  const { stash } = makeStash()
  assert.equal(crushJsonArray('{"a":1}', { maxKeptItems: 15, bias: 1, stash }).changed, false)
  assert.equal(crushJsonArray('not json at all', { maxKeptItems: 15, bias: 1, stash }).changed, false)
})

test('already-compressed output is never compressed twice', () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({ id: index, msg: 'same' }))
  const first = crush(rows).result
  assert.equal(first.changed, true)

  // Second pass on the crushed text: the sentinel must stop it.
  const second = crush(JSON.parse(first.text), {}).result
  assert.equal(second.changed, false)
})

test('scalar arrays get the string sentinel, not the object one', () => {
  // Repetitive and large enough to clear the per-content-type byte floor, but
  // non-sequential so the column is not classified as an identifier.
  const numbers = Array.from({ length: 400 }, (_, index) => ((index * 37) % 11) + ((index % 3) === 0 ? 4000 : 0))
  const { result } = crush(numbers)

  assert.equal(result.changed, true)
  const parsed = JSON.parse(result.text) as unknown[]
  const last = parsed[parsed.length - 1]

  assert.equal(typeof last, 'string')
  assert.match(last as string, /^… \d+ more items <<ccr:[a-f0-9]{12} \d+_items_offloaded>>$/)
})

test('a failing stash refuses compression instead of leaving a dangling marker', () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({ id: index, msg: 'same' }))
  const result = crushJsonArray(JSON.stringify(rows), {
    maxKeptItems: 15,
    bias: 1,
    // Simulate an unwritable CCR directory.
    stash: () => null,
  })

  assert.equal(result.changed, false)
})

test('aggressiveness changes how much is kept', () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    bucket: index % 5,
    value: index,
    label: `row ${index}`,
  }))

  const conservative = crush(rows, { bias: 1.5 }).result
  const aggressive = crush(rows, { bias: 0.7 }).result

  assert.equal(conservative.changed, true)
  assert.equal(aggressive.changed, true)

  const conservativeCount = dataRows(conservative.text).length
  const aggressiveCount = dataRows(aggressive.text).length

  assert.ok(
    aggressiveCount <= conservativeCount,
    `aggressive (${aggressiveCount}) must not keep more rows than conservative (${conservativeCount})`
  )
})
