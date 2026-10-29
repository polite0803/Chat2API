import test from 'node:test'
import assert from 'node:assert/strict'

// Pinned before any Date is built in this file so the day-boundary assertions
// below are not left to whatever timezone the runner happens to use.
process.env.TZ = 'Asia/Shanghai'
const tzApplied = new Date('2026-06-01T00:00:00').getTimezoneOffset() === -480

const { localDayKey, localDayStart, recentLocalDays, currentLocalDay, oldestTimestamp, isDayRetained } =
  await import('../../src/shared/localDay.ts')

const DAY_MS = 24 * 60 * 60 * 1000

test('a day is a local day, not a UTC one', { skip: tzApplied ? false : 'runtime ignores TZ' }, () => {
  // 16:30 UTC is 00:30 the next morning in UTC+8: the old rule filed this under
  // the previous day and labelled the newest bucket one day early.
  assert.equal(localDayKey(Date.parse('2026-10-28T16:30:00Z')), '2026-10-29')
  assert.equal(localDayStart(Date.parse('2026-10-28T16:30:00Z')), Date.parse('2026-10-28T16:00:00Z'))
})

test('recentLocalDays walks local midnights oldest first and ends today', () => {
  const now = Date.now()
  const windows = recentLocalDays(7, now)

  assert.equal(windows.length, 7)
  assert.equal(windows[6].key, localDayKey(now))
  assert.ok(windows[6].start <= now && now < windows[6].end, 'the last window must contain now')

  for (let i = 0; i < windows.length; i++) {
    const local = new Date(windows[i].start)
    assert.deepEqual(
      [local.getHours(), local.getMinutes(), local.getSeconds(), local.getMilliseconds()],
      [0, 0, 0, 0],
      `window ${i} must start at local midnight`,
    )
    assert.equal(windows[i].key, localDayKey(windows[i].start))
    if (i > 0) {
      assert.equal(windows[i - 1].end, windows[i].start, 'windows must be contiguous')
    }
  }
})

test('recentLocalDays asks for nothing without inventing a day', () => {
  assert.deepEqual(recentLocalDays(0), [])
  assert.deepEqual(recentLocalDays(-3), [])
})

test('the day before a window belongs to the previous window', () => {
  const now = Date.now()
  const windows = recentLocalDays(2, now)

  assert.equal(localDayKey(windows[1].start - 1), windows[0].key)
  assert.equal(localDayKey(windows[1].start), windows[1].key)
})

test('currentLocalDay matches the last window of recentLocalDays', () => {
  const now = Date.now()
  const today = currentLocalDay(now)

  assert.deepEqual(today, recentLocalDays(1, now)[0])
})

test('coverage is unknown until a row reaches back that far', () => {
  const today = currentLocalDay()
  const yesterday = { key: localDayKey(today.start - DAY_MS), start: today.start - DAY_MS, end: today.start }

  assert.equal(isDayRetained(undefined, today.end), false, 'no rows means no day is known')
  assert.equal(isDayRetained(today.start + 1000, today.end), true)
  assert.equal(isDayRetained(today.start + 1000, yesterday.end), false, 'yesterday predates the oldest row')
  assert.equal(isDayRetained(yesterday.start + 10, yesterday.end), true, 'a row inside a day covers it')
})

test('oldestTimestamp ignores insertion order and reports emptiness', () => {
  assert.equal(oldestTimestamp([]), undefined)
  assert.equal(oldestTimestamp([{ timestamp: 30 }, { timestamp: 10 }, { timestamp: 20 }]), 10)
})
