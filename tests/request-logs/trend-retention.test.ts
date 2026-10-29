import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RequestLogEntry } from '../../src/main/store/types.ts'
import { RequestLogManager } from '../../src/main/requestLogs/manager.ts'
import { currentLocalDay, localDayKey } from '../../src/shared/localDay.ts'

const DAY_MS = 24 * 60 * 60 * 1000

function entry(timestamp: number, overrides: Partial<RequestLogEntry> = {}): Omit<RequestLogEntry, 'id'> {
  return {
    timestamp,
    status: 'success',
    statusCode: 200,
    method: 'POST',
    url: '/v1/chat/completions',
    model: 'some-model',
    responseStatus: 200,
    latency: 120,
    isStream: false,
    ...overrides,
  }
}

async function withManager(run: (manager: RequestLogManager) => void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'modelport-trend-'))
  try {
    const manager = new RequestLogManager({
      storageDir: dir,
      config: { enabled: true, maxEntries: 50, includeBodies: false, maxBodyChars: 0, redactSensitiveData: true },
    })
    await manager.initialize()
    run(manager)
    // The manager debounces its write by 2s; flushing here keeps it from firing
    // after the temp directory is gone.
    manager.flushSync()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a day the retained logs never reach is unknown, not zero', async () => {
  await withManager((manager) => {
    const today = currentLocalDay()
    manager.addRequestLog(entry(today.start + 9 * 60 * 60 * 1000))

    const trend = manager.getRequestLogTrend(7)
    assert.equal(trend.length, 7)
    assert.equal(trend[6].date, localDayKey(Date.now()))
    assert.equal(trend[6].total, 1)
    assert.equal(trend[6].success, 1)
    assert.equal(trend[6].error, 0)

    for (const point of trend.slice(0, 6)) {
      assert.equal(point.total, null, `${point.date} predates the oldest stored row`)
      assert.equal(point.success, null)
      assert.equal(point.error, null)
      assert.equal(point.avgLatency, null)
    }
  })
})

test('an empty day inside the retained window still reports zero traffic', async () => {
  await withManager((manager) => {
    const today = currentLocalDay()
    manager.addRequestLog(entry(today.start + 60 * 60 * 1000))
    manager.addRequestLog(entry(today.start - 3 * DAY_MS + 60 * 60 * 1000))

    const trend = manager.getRequestLogTrend(7)
    const byDate = new Map(trend.map((point) => [point.date, point]))
    const threeDaysAgo = localDayKey(today.start - 3 * DAY_MS)
    const twoDaysAgo = localDayKey(today.start - 2 * DAY_MS)
    const fourDaysAgo = localDayKey(today.start - 4 * DAY_MS)

    assert.equal(byDate.get(threeDaysAgo)?.total, 1)
    assert.equal(byDate.get(twoDaysAgo)?.total, 0, 'covered but empty: a real zero')
    assert.equal(byDate.get(twoDaysAgo)?.success, 0)
    assert.equal(byDate.get(fourDaysAgo)?.total, null, 'outside the window: unknown')
  })
})

test('early-morning traffic belongs to the local day it happened on', async () => {
  await withManager((manager) => {
    const today = currentLocalDay()
    // 00:30 local: under the old UTC rule this landed in the previous day whenever
    // the machine offset from UTC, and left the newest bucket reading as yesterday.
    manager.addRequestLog(entry(today.start + 30 * 60 * 1000))

    const trend = manager.getRequestLogTrend(7)
    assert.equal(trend[6].date, localDayKey(today.start + 30 * 60 * 1000))
    assert.equal(trend[6].total, 1)
    assert.equal(trend[5].total, null)

    const stats = manager.getRequestLogStats()
    assert.equal(stats.todayTotal, 1)
    assert.equal(stats.todaySuccess, 1)
  })
})

test('avgLatency averages successes only and a covered day without any reports 0', async () => {
  await withManager((manager) => {
    const today = currentLocalDay()
    manager.addRequestLog(entry(today.start + 60 * 60 * 1000, { latency: 100 }))
    manager.addRequestLog(entry(today.start + 2 * 60 * 60 * 1000, { latency: 300 }))
    manager.addRequestLog(
      entry(today.start + 3 * 60 * 60 * 1000, { status: 'error', statusCode: 500, responseStatus: 500, latency: 5000 }),
    )
    manager.addRequestLog(entry(today.start - DAY_MS + 60 * 60 * 1000, {
      status: 'error',
      statusCode: 500,
      responseStatus: 500,
      latency: 9000,
    }))

    const trend = manager.getRequestLogTrend(7)
    assert.equal(trend[6].avgLatency, 200)
    assert.equal(trend[6].error, 1)
    assert.equal(trend[5].total, 1)
    assert.equal(trend[5].success, 0)
    assert.equal(trend[5].avgLatency, 0, 'nothing to average is reported as 0, and the dashboard reads that as no measurement')
  })
})

test('an empty store says nothing about any day', async () => {
  await withManager((manager) => {
    const trend = manager.getRequestLogTrend(7)

    assert.equal(trend.length, 7)
    assert.ok(trend.every((point) => point.total === null))
  })
})
