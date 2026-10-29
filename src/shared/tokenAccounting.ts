/**
 * Per-day token accounting, persisted separately from the request log.
 *
 * The request log is a bounded window (200 rows by default), so it cannot answer
 * "how many tokens today" — a busy proxy rotates it away within hours. These
 * counters are the durable answer, one bucket per local day.
 *
 * ## The two pools are never merged
 *
 * `usage` is `null` unless the upstream reported real numbers (see the public API
 * contract), and `UsageReading` already carries `source: 'upstream' | 'estimated'`.
 * That distinction is preserved all the way to the UI, in two separate fields:
 *
 * - `upstream` — what providers actually reported. This is the only figure that
 *   could ever be reconciled against a bill.
 * - `estimated` — `chars/4` fallback, used when no upstream usage came back.
 *   Enough for local cap metering, never a billing figure.
 *
 * Adding them into one "tokens today" number would be the easy mistake: most
 * shipped channels do not report usage at all, so the sum would be almost
 * entirely estimate while reading as fact.
 *
 * ## Savings are only what actually happened
 *
 * `savedTokens` counts compression that really took effect on a forwarded
 * request. Potential savings on skipped or disabled requests are deliberately not
 * counted — those are counterfactuals, and a dashboard must not present them as
 * measured.
 */

import { localDayKey } from './localDay.ts'

/** One day's counters. */
export interface DayTokenBucket {
  /** Tokens the upstream itself reported. */
  upstreamPrompt: number
  upstreamCompletion: number
  /** `chars/4` estimates for requests where upstream reported nothing. */
  estimatedPrompt: number
  estimatedCompletion: number
  /** Tokens compression actually removed (estimate of the saved text). */
  savedTokens: number
  /**
   * Input tokens the upstream said were **cache reads** (subset of
   * `upstreamPrompt`). Only ever accumulated from an upstream-reported usage,
   * so an estimated request contributes nothing — "we did not measure it" is
   * not "it did not happen".
   *
   * This is the field that answers "does the replayed prefix actually get
   * charged": a day with a high `upstreamPrompt` and `upstreamCacheRead` close
   * to it is paying for the same bytes again and again.
   */
  upstreamCacheRead: number
  /** Requests that contributed to this day. */
  requests: number
  /** Requests whose usage came from the upstream rather than the estimator. */
  upstreamRequests: number
}

export interface DayTokenSummary extends DayTokenBucket {
  /** Local `YYYY-MM-DD`. */
  day: string
  /**
   * `upstreamRequests / requests`, or null when nothing was recorded.
   *
   * The dashboard shows this next to the numbers so a mostly-estimated day is
   * never read as a mostly-measured one.
   */
  upstreamCoverage: number | null
}

/** Newest-first retention. 400 days is a bit over a year of history. */
const MAX_DAYS = 400

function emptyBucket(): DayTokenBucket {
  return {
    upstreamPrompt: 0,
    upstreamCompletion: 0,
    estimatedPrompt: 0,
    estimatedCompletion: 0,
    savedTokens: 0,
    upstreamCacheRead: 0,
    requests: 0,
    upstreamRequests: 0,
  }
}

function nonNegative(value: number | undefined): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0
}

/**
 * Fold one request into a day bucket. Pure: returns a new bucket, never mutates.
 *
 * Kept pure so the accumulation rule can be tested without a store, and so the
 * caller can persist the result however it needs to.
 */
export function accumulateDayBucket(
  bucket: DayTokenBucket | undefined,
  input: {
    promptTokens: number
    completionTokens: number
    source: 'upstream' | 'estimated'
    savedTokens?: number
    /** Cache-read input tokens, only meaningful when `source` is `upstream`. */
    cacheReadTokens?: number
  }
): DayTokenBucket {
  // ⚠️ 走 `normalizeDayBucket` 而不是直接信任入参：调用方喂的是**磁盘上读出来**
  // 的对象。老文件没有 `upstreamCacheRead`（这个字段是后加的），直接相加会算出
  // `NaN` 并一路写回存储，把这一天的全部计数污染成不可显示。`normalizeDayBucket`
  // 本来就是"手改的文件不能毒化总量"的守卫，这里过去没用它才是漏的那一半。
  const base = normalizeDayBucket(bucket)
  const prompt = nonNegative(input.promptTokens)
  const completion = nonNegative(input.completionTokens)
  const saved = nonNegative(input.savedTokens)
  const isUpstream = input.source === 'upstream'

  return {
    upstreamPrompt: base.upstreamPrompt + (isUpstream ? prompt : 0),
    upstreamCompletion: base.upstreamCompletion + (isUpstream ? completion : 0),
    estimatedPrompt: base.estimatedPrompt + (isUpstream ? 0 : prompt),
    estimatedCompletion: base.estimatedCompletion + (isUpstream ? 0 : completion),
    savedTokens: base.savedTokens + saved,
    // 估算请求**不可能**带来缓存命中：写了就是把"没测到"伪装成"测到了"。
    upstreamCacheRead: base.upstreamCacheRead + (isUpstream ? nonNegative(input.cacheReadTokens) : 0),
    requests: base.requests + 1,
    upstreamRequests: base.upstreamRequests + (isUpstream ? 1 : 0),
  }
}

/** Project a stored bucket into the report shape, adding the day key and coverage. */
export function summarizeDay(day: string, bucket: DayTokenBucket): DayTokenSummary {
  const requests = bucket.requests
  return {
    ...bucket,
    day,
    upstreamCoverage: requests > 0 ? bucket.upstreamRequests / requests : null,
  }
}

/**
 * Trim the map to the newest `MAX_DAYS` keys by calendar day.
 *
 * Keys are `YYYY-MM-DD`, so a plain string sort is chronological — no timestamp
 * parsing and no timezone dependency.
 */
export function trimDays(
  buckets: Record<string, DayTokenBucket>,
  maxDays: number = MAX_DAYS
): Record<string, DayTokenBucket> {
  const keys = Object.keys(buckets)
  if (keys.length <= maxDays) return buckets

  const keep = new Set(keys.sort().slice(-maxDays))
  const trimmed: Record<string, DayTokenBucket> = {}
  for (const key of keys) {
    if (keep.has(key)) trimmed[key] = buckets[key]
  }
  return trimmed
}

/** Normalize one persisted bucket, so a hand-edited file cannot poison totals. */
export function normalizeDayBucket(input: unknown): DayTokenBucket {
  const raw = (input ?? {}) as Record<string, unknown>
  // 字段清单只有 `emptyBucket()` 一处：逐键清洗，而不是逐个字段手写一遍。
  // 这条不是偷懒 —— 本次给接口加 `upstreamCacheRead` 时，如果这里仍是手抄清单，
  // 忘记加它就会让**旧文件读出来的桶**缺这个键，然后 `accumulateDayBucket`
  // 拿它去相加，把这一整天全部计数写成 `NaN`。
  const next = emptyBucket()
  for (const key of Object.keys(next) as (keyof DayTokenBucket)[]) {
    next[key] = nonNegative(raw[key] as number)
  }
  return next
}

/** The local day key for a timestamp, re-exported so callers need one import. */
export function tokenDayKey(timestamp: number = Date.now()): string {
  return localDayKey(timestamp)
}
