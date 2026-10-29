import type { AppLogTrendPoint, RequestLogTrendPoint } from './types.ts'

/**
 * The dashboard compares today with yesterday. Both sides can be unknown -
 * a day outside the retained log window, or a day with no successful request to
 * average - and an unknown is not a 0% change.
 */
export interface DayCounts {
  requests: number | null
  success: number | null
  avgLatency: number | null
}

/**
 * The two trend sources answer different questions: request logs know requests,
 * successes and latency; app logs only know how many info lines were written.
 */
export function dayCountsOf(
  point: RequestLogTrendPoint | AppLogTrendPoint | undefined,
  fromRequestLogs: boolean,
): DayCounts {
  if (!point) return { requests: null, success: null, avgLatency: null }
  if (fromRequestLogs) {
    const requestPoint = point as RequestLogTrendPoint
    return { requests: requestPoint.total, success: requestPoint.success, avgLatency: requestPoint.avgLatency }
  }
  const appPoint = point as AppLogTrendPoint
  return { requests: appPoint.total, success: appPoint.info, avgLatency: null }
}

export function successRateOf(counts: DayCounts): number | null {
  if (counts.requests === null || counts.success === null || counts.requests === 0) return null
  return Math.round((counts.success / counts.requests) * 100)
}

/** `null` when either side is unknown; a real zero base still reads as +100%. */
export function percentChange(current: number | null, base: number | null): number | null {
  if (current === null || base === null) return null
  if (base === 0) return current > 0 ? 100 : 0
  return Math.round(((current - base) / base) * 100)
}

export function differenceInPoints(current: number | null, base: number | null): number | null {
  if (current === null || base === null) return null
  return current - base
}

/**
 * Indices of non-null values with no non-null neighbour. A series that survives
 * on a single day has to be drawn as a marker: one point is a `moveto`, and a
 * path with no segment paints nothing, which reads exactly like "no data".
 */
export function isolatedIndices(values: Array<number | null>): number[] {
  const indices: number[] = []
  values.forEach((value, index) => {
    if (value === null) return
    const previous = index > 0 ? values[index - 1] : null
    const next = index < values.length - 1 ? values[index + 1] : null
    if (previous === null && next === null) indices.push(index)
  })
  return indices
}
