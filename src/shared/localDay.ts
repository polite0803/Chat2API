/**
 * Day windows for every per-day aggregate (trend charts, daily stats, the
 * "vs yesterday" cards).
 *
 * A day is a *local* day here: the app is a desktop tool, so a bucket that
 * flips at 08:00 local time (which is what UTC midnight does in UTC+8) makes
 * the newest bucket read as yesterday and files the early-morning traffic
 * under the previous day.
 */

export interface DayWindow {
  /** Local calendar day, `YYYY-MM-DD` */
  key: string
  /** Inclusive start, ms epoch at local midnight */
  start: number
  /** Exclusive end, ms epoch at the next local midnight */
  end: number
}

export function localDayStart(timestamp: number): number {
  const day = new Date(timestamp)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

export function localDayKey(timestamp: number): string {
  const day = new Date(timestamp)
  const month = `${day.getMonth() + 1}`.padStart(2, '0')
  const date = `${day.getDate()}`.padStart(2, '0')
  return `${day.getFullYear()}-${month}-${date}`
}

/**
 * The `days` local days ending with the one `now` falls in, oldest first.
 * Stepping with `setDate` keeps the window boundaries on local midnight even
 * when a daylight-saving transition makes one of the days 23 or 25 hours long.
 */
export function recentLocalDays(days: number, now: number = Date.now()): DayWindow[] {
  const count = Math.max(0, Math.floor(days))
  const anchor = new Date(localDayStart(now))
  const windows: DayWindow[] = []

  for (let offset = count - 1; offset >= 0; offset--) {
    const start = new Date(anchor)
    start.setDate(start.getDate() - offset)
    const end = new Date(start)
    end.setDate(end.getDate() + 1)
    windows.push({ key: localDayKey(start.getTime()), start: start.getTime(), end: end.getTime() })
  }

  return windows
}

/** The current local day, so callers never re-derive "today" from a timestamp. */
export function currentLocalDay(now: number = Date.now()): DayWindow {
  const start = localDayStart(now)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { key: localDayKey(start), start, end: end.getTime() }
}

/** Oldest timestamp of a retention-capped list; `undefined` when nothing is stored. */
export function oldestTimestamp(entries: Array<{ timestamp: number }>): number | undefined {
  let oldest: number | undefined
  for (const entry of entries) {
    if (oldest === undefined || entry.timestamp < oldest) {
      oldest = entry.timestamp
    }
  }
  return oldest
}

/**
 * Whether stored logs can speak for a day at all. Everything before the oldest
 * retained row is unknown, not zero.
 */
export function isDayRetained(oldest: number | undefined, dayEnd: number): boolean {
  return oldest !== undefined && oldest < dayEnd
}
