import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { RequestLogEntry } from '../../src/shared/types.ts'
import { summarizeDuplication } from '../../src/main/proxy/compression/duplicationSummary.ts'

/** A log row carrying a measurement. */
function measured(
  duplicatedChars: number,
  scannedChars: number,
  extra?: { blocks?: number; truncated?: boolean; longestRunLines?: number }
): RequestLogEntry {
  return {
    duplication: {
      blocks: extra?.blocks ?? 2,
      scannedChars,
      duplicatedChars,
      runs: duplicatedChars > 0 ? 1 : 0,
      longestRunLines: extra?.longestRunLines ?? 0,
      truncated: extra?.truncated ?? false,
    },
  } as RequestLogEntry
}

/** A log row with no measurement at all (single-turn request). */
function unmeasured(): RequestLogEntry {
  return {} as RequestLogEntry
}

test('an empty window reports null rather than a zero ratio', () => {
  const summary = summarizeDuplication([])

  assert.equal(summary.sampled, 0)
  assert.equal(summary.unmeasured, 0)
  assert.equal(summary.ratio, null)
  assert.equal(summary.duplicatedChars, 0)
})

test('unmeasured rows are counted separately and never as zeros', () => {
  // The distinction matters: mixing "not looked at" into the ratio denominator
  // would make a window of single-turn traffic look like measured proof that
  // there is no duplication.
  const summary = summarizeDuplication([unmeasured(), unmeasured(), measured(400, 2000)])

  assert.equal(summary.sampled, 1)
  assert.equal(summary.unmeasured, 2)
  assert.equal(summary.ratio, 0.2)
})

test('the ratio is computed over the sample only', () => {
  const summary = summarizeDuplication([measured(1000, 4000), measured(0, 2000)])

  assert.equal(summary.duplicatedChars, 1000)
  assert.equal(summary.scannedChars, 6000)
  assert.equal(summary.ratio, 1000 / 6000)
})

test('a measured zero is a real zero, distinct from null', () => {
  // Scanned something, found no duplication: ratio is 0, not null.
  const summary = summarizeDuplication([measured(0, 5000)])
  assert.equal(summary.ratio, 0)
  assert.equal(summary.requestsWithDuplication, 0)
})

test('requests with duplication and truncation are counted independently', () => {
  const summary = summarizeDuplication([
    measured(800, 3000, { truncated: true }),
    measured(0, 1000),
    measured(200, 2000, { longestRunLines: 40 }),
  ])

  assert.equal(summary.requestsWithDuplication, 2)
  assert.equal(summary.truncatedRequests, 1)
  assert.equal(summary.maxDuplicatedChars, 800)
  assert.equal(summary.longestRunLines, 40)
})

test('multi-block requests are distinguished from single-block ones', () => {
  const summary = summarizeDuplication([
    measured(0, 900, { blocks: 1 }),
    measured(300, 4000, { blocks: 5 }),
  ])

  assert.equal(summary.sampled, 2)
  assert.equal(summary.multiBlockRequests, 1)
})

test('the threshold reading follows the documented boundaries', () => {
  // 0.2 exactly is "worth building"; below 0.05 is "negligible".
  const atThreshold = summarizeDuplication([measured(200, 1000)])
  assert.equal(atThreshold.ratio, 0.2)

  const negligible = summarizeDuplication([measured(40, 1000)])
  assert.equal(negligible.ratio, 0.04)

  const middling = summarizeDuplication([measured(100, 1000)])
  assert.equal(middling.ratio, 0.1)
})

test('aggregation does not mutate the entries it reads', () => {
  const entries = [measured(500, 2000), unmeasured()]
  const before = JSON.stringify(entries)

  summarizeDuplication(entries)

  assert.equal(JSON.stringify(entries), before)
})
