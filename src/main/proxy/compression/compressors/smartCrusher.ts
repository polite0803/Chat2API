/**
 * Statistical JSON array compression ("SmartCrusher").
 *
 * A JSON array tool output (search hits, issue lists, log records) is usually
 * highly redundant: most rows are unremarkable and a handful matter — the error
 * rows, the statistical outliers, the change points. This compressor keeps the
 * rows that carry signal and drops the rest, replacing them with a sentinel that
 * carries a CCR hash so the original is still reachable.
 *
 * Ported from headroom's `transforms/smart_crusher/` (Apache-2.0), restricted to
 * the statistically-gated path. The upstream "lossless table compaction" and
 * TOIN/feedback machinery are intentionally absent.
 *
 * Non-negotiable rules, all enforced below:
 *
 * - Outlier / error / anomaly / change-point rows are **never** dropped, even
 *   when they alone exceed the budget. The result may therefore keep more rows
 *   than `maxKeptItems`; that is deliberate, not a bug.
 * - A unique-entity payload with no signal at all is **not** compressed
 *   (`analyzeCrushability` returns `skip`): every row matters there.
 * - If the original cannot be stashed, nothing is compressed — a marker without
 *   its original loses data.
 * - Only the live zone is ever handed to this function (see `liveZone.ts`).
 */

import { createHash } from 'crypto'
import { computeOptimalK } from '../signals/adaptiveSizer.ts'
import { hasErrorKeyword } from '../signals/errorKeywords.ts'
import { isCcrSentinel, isAlreadyCompressed, makeItemSentinel, makeRowSentinel, JSON_HASH_LENGTH } from '../ccr/markers.ts'

/** Rows below this count are not analysed at all. */
const MIN_ITEMS_TO_ANALYZE = 5
/** Standard deviations from the mean that count as an anomaly. */
const VARIANCE_THRESHOLD = 2
/** Change-point window: half-width of the before/after mean comparison. */
const CHANGE_POINT_WINDOW = 5
/** A field present in fewer than this fraction of rows is "rare". */
const RARE_FIELD_FRACTION = 0.2
/** A field present in at least this fraction of rows is "common". */
const COMMON_FIELD_FRACTION = 0.8
/** Rare-status cardinality bounds. */
const STATUS_MIN_CARDINALITY = 2
const STATUS_MAX_CARDINALITY = 50
/** Pareto coverage for rare-status detection. */
const STATUS_COVERAGE = 0.8
const STATUS_MAX_TOP_K = 5
/** Anchor budget, as a fraction of the retained count. */
const ANCHOR_BUDGET_FRACTION = 0.25
const ANCHOR_MIN_SLOTS = 3
const ANCHOR_MAX_SLOTS = 12
const ANCHOR_FRONT_WEIGHT = 0.5
const ANCHOR_BACK_WEIGHT = 0.4
/** Scalar-array first/last split. */
const SCALAR_FIRST_FRACTION = 0.3
const SCALAR_LAST_FRACTION = 0.15
/** Relative margin below which a compression is not worth applying. */
const MIN_ARRAY_BYTES = 512

export type CrushabilityVerdict =
  | { crush: true; confidence: number; reason: string }
  | { crush: false; confidence: number; reason: string }

export interface SmartCrushOptions {
  /** Retained row ceiling (`max_items_after_crush`). */
  maxKeptItems: number
  /** Aggressiveness multiplier for `computeOptimalK`. */
  bias: number
  /**
   * Persist the original and return the id to embed in the marker.
   * Returning `null` means "do not compress" — the caller forwards the original.
   */
  stash: (original: string, idLength: number) => string | null
}

export interface SmartCrushResult {
  text: string
  changed: boolean
  ccrHash?: string
  strategy: string
}

interface NumericStats {
  min: number
  max: number
  mean: number
  stdev: number
}

export interface FieldStats {
  name: string
  presentCount: number
  /** All values including nulls, in row order. */
  values: unknown[]
  uniqueCount: number
  uniqueRatio: number
  constant: boolean
  type: 'null' | 'boolean' | 'numeric' | 'string' | 'object' | 'array'
  avgLength?: number
  numeric?: NumericStats
  changePoints: number[]
  /** 0..1 confidence that this field is an identifier. */
  idConfidence: number
}

function toStr(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  let total = 0
  for (const value of values) total += value
  return total / values.length
}

/** Sample standard deviation (n-1), matching headroom's `sample_stdev`. */
function sampleStdev(values: readonly number[]): number {
  if (values.length < 2) return 0
  const average = mean(values)
  let sum = 0
  for (const value of values) {
    const delta = value - average
    sum += delta * delta
  }
  return Math.sqrt(sum / (values.length - 1))
}

/**
 * Change points in a row-aligned numeric series.
 *
 * `points` pairs a row index with its value so a column containing nulls does
 * not shift every subsequent detection: the window arithmetic runs over values,
 * but the result is reported back in ROW coordinates.
 */
function detectChangePoints(points: ReadonlyArray<{ row: number; value: number }>): number[] {
  const window = CHANGE_POINT_WINDOW
  if (points.length < window * 2) return []
  const values = points.map(point => point.value)
  const stdev = sampleStdev(values)
  if (!(stdev > 0)) return []
  const threshold = VARIANCE_THRESHOLD * stdev

  const rows: number[] = []
  let lastValueIndex = Number.NEGATIVE_INFINITY
  for (let index = window; index < values.length - window; index += 1) {
    const before = mean(values.slice(index - window, index))
    const after = mean(values.slice(index, index + window))
    if (Math.abs(after - before) > threshold) {
      if (rows.length === 0 || index - lastValueIndex > window) {
        rows.push(points[index].row)
        lastValueIndex = index
      }
    }
  }
  return rows
}

function stringEntropy(text: string): number {
  if (text.length === 0) return 0
  const counts = new Map<string, number>()
  for (const char of text) {
    counts.set(char, (counts.get(char) ?? 0) + 1)
  }
  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / text.length
    entropy -= probability * Math.log2(probability)
  }
  // Normalize by log2(min(distinct, length)) so the score is comparable across
  // value lengths, matching headroom's `statistics.rs`.
  const normalizer = Math.log2(Math.min(counts.size, text.length))
  return normalizer > 0 ? entropy / normalizer : 0
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Sequential-integer detection: mean gap in [0.5, 2] for >80% of gaps. */
function isSequentialNumeric(values: readonly number[]): boolean {
  if (values.length < 5) return false
  const sorted = [...values].sort((a, b) => a - b)
  const gaps: number[] = []
  for (let index = 1; index < sorted.length; index += 1) {
    gaps.push(sorted[index] - sorted[index - 1])
  }
  const inBand = gaps.filter(gap => gap >= 0.5 && gap <= 2).length
  return gaps.length > 0 && inBand / gaps.length > 0.8
}

/**
 * Confidence that a field is an identifier. Gate is `uniqueRatio >= 0.9`;
 * everything above that is a ranked guess (headroom `field_detect.rs:36-93`).
 */
function detectIdConfidence(stats: FieldStats, samples: readonly unknown[]): number {
  if (stats.uniqueRatio < 0.9) return 0

  if (stats.type === 'string') {
    const strings = samples.filter((value): value is string => typeof value === 'string').slice(0, 20)
    if (strings.length > 0) {
      const uuidLike = strings.filter(value => UUID_SHAPE.test(value)).length
      if (uuidLike / strings.length > 0.8) return 0.95
      const entropy = mean(strings.map(stringEntropy))
      if (entropy > 0.7 && stats.uniqueRatio > 0.95) return 0.8
    }
  }

  if (stats.type === 'numeric') {
    const numbers = samples.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (numbers.length > 0) {
      if (isSequentialNumeric(numbers) && stats.uniqueRatio > 0.95) return 0.9
      const minimum = Math.min(...numbers)
      const maximum = Math.max(...numbers)
      if (maximum > minimum && stats.uniqueRatio > 0.95) return 0.85
    }
  }

  if (stats.uniqueRatio > 0.98) return 0.7
  return 0
}

function analyzeField(name: string, items: readonly Record<string, unknown>[]): FieldStats {
  const values: unknown[] = []
  for (const item of items) {
    values.push(Object.prototype.hasOwnProperty.call(item, name) ? item[name] : null)
  }

  const stringValues = values.map(toStr)
  const uniqueCount = new Set(stringValues).size
  const nonNull = values.filter(value => value !== null && value !== undefined)

  let type: FieldStats['type'] = 'null'
  if (nonNull.length > 0) {
    const first = nonNull[0]
    if (typeof first === 'boolean') type = 'boolean'
    else if (typeof first === 'number') type = 'numeric'
    else if (typeof first === 'string') type = 'string'
    else if (Array.isArray(first)) type = 'array'
    else type = 'object'
  }

  const stats: FieldStats = {
    name,
    presentCount: values.filter(value => value !== null && value !== undefined).length,
    values,
    uniqueCount,
    uniqueRatio: values.length > 0 ? uniqueCount / values.length : 0,
    constant: uniqueCount === 1,
    type,
    changePoints: [],
    idConfidence: 0,
  }

  if (type === 'numeric') {
    const numbers = nonNull.filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value)
    )
    if (numbers.length > 0) {
      const average = mean(numbers)
      const stdev = sampleStdev(numbers)
      if (Number.isFinite(average) && Number.isFinite(stdev)) {
        stats.numeric = {
          min: Math.min(...numbers),
          max: Math.max(...numbers),
          mean: average,
          stdev,
        }
        // Change points are only meaningful across the whole column, in order,
        // and must be reported in row coordinates (nulls shift nothing).
        const series: Array<{ row: number; value: number }> = []
        values.forEach((value, row) => {
          if (typeof value === 'number' && Number.isFinite(value)) {
            series.push({ row, value })
          }
        })
        stats.changePoints = detectChangePoints(series)
      }
    }
  }

  if (type === 'string') {
    const lengths = nonNull.filter((value): value is string => typeof value === 'string').map(value => value.length)
    if (lengths.length > 0) stats.avgLength = mean(lengths)
  }

  stats.idConfidence = detectIdConfidence(stats, nonNull)
  return stats
}

/** Rows containing a field present in fewer than 20% of rows. */
function rareFieldOutlierIndices(
  items: readonly Record<string, unknown>[],
  stats: readonly FieldStats[]
): number[] {
  const n = items.length
  const rareFields = stats
    .filter(field => field.presentCount < n * RARE_FIELD_FRACTION)
    .map(field => field.name)
  if (rareFields.length === 0) return []

  const indices: number[] = []
  items.forEach((item, index) => {
    if (rareFields.some(name => Object.prototype.hasOwnProperty.call(item, name))) {
      indices.push(index)
    }
  })
  return indices
}

/**
 * Rows whose value in a status-like column falls outside the dominant values.
 *
 * Pareto form: grow the top-K until it covers 80% of rows; if that took at most
 * five distinct values the column is categorical and everything else is rare.
 * A uniform distribution never satisfies this, which is what stops an ordinary
 * category column from marking every row as an outlier.
 */
function rareStatusOutlierIndices(
  items: readonly Record<string, unknown>[],
  stats: readonly FieldStats[]
): number[] {
  const n = items.length
  const indices: number[] = []

  for (const field of [...stats].sort((a, b) => a.name.localeCompare(b.name))) {
    if (field.presentCount < n * COMMON_FIELD_FRACTION) continue

    const nonNull = field.values.filter(value => value !== null && value !== undefined)
    const distinct = new Set(nonNull.map(toStr))
    if (distinct.size < STATUS_MIN_CARDINALITY || distinct.size > STATUS_MAX_CARDINALITY) continue

    const counts = new Map<string, number>()
    for (const value of field.values) {
      const key = value === null || value === undefined ? '__none__' : toStr(value)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const threshold = Math.ceil(field.values.length * STATUS_COVERAGE)
    let cumulative = 0
    const topK = new Set<string>()
    for (const [key, count] of sorted) {
      cumulative += count
      topK.add(key)
      if (cumulative >= threshold) break
    }
    if (topK.size > STATUS_MAX_TOP_K) continue

    items.forEach((item, index) => {
      if (!Object.prototype.hasOwnProperty.call(item, field.name)) return
      const value = item[field.name]
      const key = value === null || value === undefined ? '__none__' : toStr(value)
      if (!topK.has(key)) indices.push(index)
    })
  }

  return indices
}

function errorRowIndices(items: readonly Record<string, unknown>[], serialized: readonly string[]): number[] {
  const indices: number[] = []
  serialized.forEach((text, index) => {
    if (hasErrorKeyword(text)) indices.push(index)
  })
  return indices
}

function numericAnomalyIndices(
  items: readonly Record<string, unknown>[],
  stats: readonly FieldStats[]
): number[] {
  const indices = new Set<number>()

  for (const field of stats) {
    if (!field.numeric) continue
    const { mean: average, stdev } = field.numeric
    if (!(stdev > 0)) continue
    const threshold = VARIANCE_THRESHOLD * stdev

    items.forEach((item, index) => {
      const value = item[field.name]
      if (typeof value !== 'number' || !Number.isFinite(value)) return
      if (Math.abs(value - average) > threshold) indices.add(index)
    })
  }

  return [...indices].sort((a, b) => a - b)
}

function changePointRowIndices(stats: readonly FieldStats[], n: number): number[] {
  const indices = new Set<number>()
  for (const field of stats) {
    for (const point of field.changePoints) {
      for (const offset of [-1, 0, 1]) {
        const index = point + offset
        if (index >= 0 && index < n) indices.add(index)
      }
    }
  }
  return [...indices].sort((a, b) => a - b)
}

/**
 * Decide whether this array *should* be compressed at all.
 *
 * The two `skip` verdicts are the quality guard: a payload where every row is
 * distinct and nothing marks any of them as special is exactly the case where
 * sampling silently destroys information.
 */
export function analyzeCrushability(
  stats: readonly FieldStats[],
  signals: {
    errorCount: number
    outlierCount: number
    anomalyCount: number
    hasChangePoints: boolean
  }
): CrushabilityVerdict {
  const idFields = stats.filter(field => field.idConfidence >= 0.7)
  const hasIdField = idFields.length > 0

  const stringFields = stats.filter(field => field.type === 'string')
  const avgStringUniqueness =
    stringFields.length > 0 ? mean(stringFields.map(field => field.uniqueRatio)) : 0

  const idUniqueness = idFields.length > 0 ? Math.max(...idFields.map(field => field.uniqueRatio)) : 0

  const nonIdNumeric = stats.filter(
    field => field.type === 'numeric' && field.idConfidence < 0.7
  )
  const avgNonIdNumericUniqueness =
    nonIdNumeric.length > 0 ? mean(nonIdNumeric.map(field => field.uniqueRatio)) : 0

  const maxUniqueness = Math.max(avgStringUniqueness, idUniqueness)
  const nonIdContentUniqueness = Math.max(avgStringUniqueness, avgNonIdNumericUniqueness)
  const anySignal =
    signals.errorCount > 0 ||
    signals.outlierCount > 0 ||
    signals.anomalyCount > 0 ||
    signals.hasChangePoints

  if (nonIdContentUniqueness < 0.1 && hasIdField) {
    return { crush: true, confidence: 0.85, reason: 'repetitive_content_with_ids' }
  }
  if (maxUniqueness < 0.3) {
    return { crush: true, confidence: 0.9, reason: 'low_uniqueness_safe_to_sample' }
  }
  if (hasIdField && maxUniqueness > 0.8 && !anySignal) {
    return { crush: false, confidence: 0.85, reason: 'unique_entities_no_signal' }
  }
  if (maxUniqueness > 0.8 && anySignal) {
    return { crush: true, confidence: 0.7, reason: 'unique_entities_with_signal' }
  }
  if (!anySignal) {
    return { crush: false, confidence: 0.6, reason: 'medium_uniqueness_no_signal' }
  }
  return { crush: true, confidence: 0.5, reason: 'medium_uniqueness_with_signal' }
}

/** Content hash used to collapse identical rows before sampling. */
function contentKey(item: unknown): string {
  return createHash('sha1').update(JSON.stringify(item) ?? '', 'utf8').digest('hex')
}

function dedupeIndices(keep: ReadonlySet<number>, items: readonly unknown[]): Set<number> {
  const seen = new Set<string>()
  const result = new Set<number>()
  for (const index of [...keep].sort((a, b) => a - b)) {
    const key = contentKey(items[index])
    if (seen.has(key)) continue
    seen.add(key)
    result.add(index)
  }
  return result
}

/** Top up to `target` with evenly strided, content-distinct rows. */
function fillRemainingSlots(
  keep: ReadonlySet<number>,
  items: readonly unknown[],
  target: number
): Set<number> {
  const n = items.length
  const result = new Set(keep)
  const seen = new Set([...keep].map(index => contentKey(items[index])))
  const candidates: number[] = []
  for (let index = 0; index < n; index += 1) {
    if (!result.has(index)) candidates.push(index)
  }
  if (candidates.length === 0) return result

  const remaining = target - result.size
  if (remaining <= 0) return result

  const step = Math.max(1, Math.floor(candidates.length / (remaining + 1)))
  let added = 0
  outer: for (let offset = 0; offset < step; offset += 1) {
    for (let cursor = offset; cursor < candidates.length; cursor += step) {
      if (added >= remaining) break outer
      const index = candidates[cursor]
      const key = contentKey(items[index])
      if (seen.has(key)) continue
      result.add(index)
      seen.add(key)
      added += 1
    }
  }
  return result
}

/**
 * Final budget governor.
 *
 * Critical rows (errors, outliers, anomalies) are inserted first and survive
 * unconditionally; only then are first/last anchors and ordinary rows allowed
 * to fill the remainder. The documented consequence is that the returned set
 * may exceed `effectiveMax` when critical rows alone overflow it.
 */
export function prioritizeIndices(input: {
  keep: ReadonlySet<number>
  items: readonly unknown[]
  effectiveMax: number
  critical: readonly number[]
}): Set<number> {
  const { items, effectiveMax } = input
  const n = items.length

  let current = dedupeIndices(input.keep, items)
  if (current.size < effectiveMax && current.size < n) {
    current = fillRemainingSlots(current, items, effectiveMax)
  }
  if (current.size <= effectiveMax) return current

  const prioritized = new Set<number>(input.critical)
  let remaining = effectiveMax - prioritized.size

  if (remaining > 0) {
    for (let index = 0; index < Math.min(3, n); index += 1) {
      if (remaining <= 0) break
      if (prioritized.has(index)) continue
      prioritized.add(index)
      remaining -= 1
    }
    for (let index = Math.max(0, n - 2); index < n; index += 1) {
      if (remaining <= 0) break
      if (prioritized.has(index)) continue
      prioritized.add(index)
      remaining -= 1
    }
  }

  if (remaining > 0) {
    const others = [...current].filter(index => !prioritized.has(index)).sort((a, b) => a - b)
    for (const index of others) {
      if (remaining <= 0) break
      prioritized.add(index)
      remaining -= 1
    }
  }

  return prioritized
}

/** Anchor slots for an object array: first / middle / last. */
function anchorIndices(n: number, budget: number): number[] {
  const budgetClamped = Math.max(ANCHOR_MIN_SLOTS, Math.min(ANCHOR_MAX_SLOTS, budget))
  const frontSlots = Math.max(1, Math.floor(budgetClamped * ANCHOR_FRONT_WEIGHT))
  const backSlots = Math.max(1, Math.floor(budgetClamped * ANCHOR_BACK_WEIGHT))
  const middleSlots = Math.max(0, budgetClamped - frontSlots - backSlots)

  const indices = new Set<number>()
  for (let index = 0; index < Math.min(frontSlots, n); index += 1) indices.add(index)
  for (let index = Math.max(0, n - backSlots); index < n; index += 1) indices.add(index)

  if (middleSlots > 0) {
    const start = frontSlots
    const end = Math.max(start + 1, n - backSlots)
    const span = end - start
    for (let slot = 1; slot <= middleSlots && span > 0; slot += 1) {
      const index = start + Math.floor((span * slot) / (middleSlots + 1))
      if (index >= 0 && index < n) indices.add(index)
    }
  }

  return [...indices]
}

/** Round half to even, matching Python's `round`. */
function roundHalfEven(value: number): number {
  const truncated = Math.trunc(value)
  const fraction = value - truncated
  if (fraction > 0.5) return truncated + 1
  if (fraction < 0.5) return truncated
  return truncated % 2 === 0 ? truncated : truncated + 1
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Render kept rows plus the row-drop sentinel and stash the original.
 * Returns null when the original could not be stashed.
 */
function renderObjectCrush(
  original: readonly unknown[],
  kept: readonly number[],
  options: SmartCrushOptions
): { text: string; hash: string } | null {
  const canonical = JSON.stringify(original)
  const hash = options.stash(canonical, JSON_HASH_LENGTH)
  if (!hash) return null

  const dropped = original.length - kept.length
  const rows = kept.map(index => original[index])
  rows.push(makeRowSentinel(hash, dropped))
  return { text: JSON.stringify(rows), hash }
}

function renderScalarCrush(
  original: readonly unknown[],
  kept: readonly number[],
  options: SmartCrushOptions
): { text: string; hash: string } | null {
  const canonical = JSON.stringify(original)
  const hash = options.stash(canonical, JSON_HASH_LENGTH)
  if (!hash) return null

  const dropped = original.length - kept.length
  const items = kept.map(index => original[index])
  items.push(makeItemSentinel(hash, dropped))
  return { text: JSON.stringify(items), hash }
}

function unchanged(strategy: string): SmartCrushResult {
  return { text: '', changed: false, strategy }
}

/**
 * Compress one JSON array.
 *
 * `text` in the result is only meaningful when `changed` is true.
 */
export function crushJsonArray(text: string, options: SmartCrushOptions): SmartCrushResult {
  if (text.length < MIN_ARRAY_BYTES) return unchanged('below_min_bytes')

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return unchanged('not_json')
  }
  if (!Array.isArray(parsed)) return unchanged('not_array')

  const n = parsed.length
  if (n < MIN_ITEMS_TO_ANALYZE) return unchanged('below_min_items')

  // A payload that already carries a sentinel is compressed output, not source.
  if (parsed.some(isCcrSentinel)) return unchanged('already_compressed')

  const objectItems = parsed.filter(isPlainObject)
  const allObjects = objectItems.length === n
  const allStrings = parsed.every(item => typeof item === 'string')
  const allNumbers = parsed.every(item => typeof item === 'number' && Number.isFinite(item))

  if (!allObjects && !allStrings && !allNumbers) {
    // Mixed arrays are left alone: the per-group handling adds a mode whose
    // failure surface (group boundaries, ordering) is not worth its savings.
    return unchanged('mixed_array')
  }

  if (allObjects) return crushObjectArray(objectItems, options)
  return crushScalarArray(parsed, allStrings, options)
}

function crushObjectArray(
  items: readonly Record<string, unknown>[],
  options: SmartCrushOptions
): SmartCrushResult {
  const n = items.length
  const serialized = items.map(item => JSON.stringify(item))

  const fieldNames = new Set<string>()
  for (const item of items) {
    for (const key of Object.keys(item)) fieldNames.add(key)
  }
  const stats = [...fieldNames].map(name => analyzeField(name, items))

  const errors = errorRowIndices(items, serialized)
  const rareFields = rareFieldOutlierIndices(items, stats)
  const rareStatuses = rareStatusOutlierIndices(items, stats)
  const anomalies = numericAnomalyIndices(items, stats)
  const changePoints = changePointRowIndices(stats, n)

  const outlierSet = new Set([...rareFields, ...rareStatuses])

  const verdict = analyzeCrushability(stats, {
    errorCount: errors.length,
    outlierCount: outlierSet.size,
    anomalyCount: anomalies.length,
    hasChangePoints: changePoints.length > 0,
  })
  if (!verdict.crush) return unchanged(`skip:${verdict.reason}`)

  const adaptiveK = computeOptimalK(serialized, {
    bias: options.bias,
    minK: 3,
    maxK: options.maxKeptItems,
  })
  if (n <= adaptiveK) return unchanged('none:adaptive_at_limit')

  const keep = new Set<number>()

  const anchorBudget = Math.floor(options.maxKeptItems * ANCHOR_BUDGET_FRACTION)
  for (const index of anchorIndices(n, anchorBudget)) keep.add(index)

  for (const index of errors) keep.add(index)
  for (const index of outlierSet) keep.add(index)
  for (const index of anomalies) keep.add(index)
  for (const index of changePoints) keep.add(index)

  const critical = [...new Set([...errors, ...outlierSet, ...anomalies])].sort((a, b) => a - b)
  const selected = prioritizeIndices({
    keep,
    items,
    effectiveMax: adaptiveK,
    critical,
  })

  // Nothing was actually dropped: report no change rather than emit a
  // byte-different payload that saves nothing.
  if (selected.size >= n) return unchanged('none:nothing_dropped')

  const keptIndices = [...selected].sort((a, b) => a - b)
  const rendered = renderObjectCrush(items, keptIndices, options)
  if (!rendered) return unchanged('ccr_unavailable')

  return {
    text: rendered.text,
    changed: true,
    ccrHash: rendered.hash,
    strategy: `smart_sample(${n}->${keptIndices.length})`,
  }
}

function crushScalarArray(
  items: readonly unknown[],
  allStrings: boolean,
  options: SmartCrushOptions
): SmartCrushResult {
  const n = items.length
  if (n <= 8) return unchanged('below_min_items')

  const serialized = items.map(item => JSON.stringify(item))
  const adaptiveK = computeOptimalK(serialized, {
    bias: options.bias,
    minK: 3,
    maxK: options.maxKeptItems,
  })
  if (n <= adaptiveK) return unchanged('none:adaptive_at_limit')

  const keep = new Set<number>()

  const firstCount = Math.max(1, roundHalfEven(adaptiveK * SCALAR_FIRST_FRACTION))
  const lastCount = Math.max(1, roundHalfEven(adaptiveK * SCALAR_LAST_FRACTION))
  const kFirst = Math.min(firstCount, adaptiveK)
  const kLast = Math.min(lastCount, adaptiveK - kFirst)
  for (let index = 0; index < kFirst; index += 1) keep.add(index)
  for (let index = Math.max(0, n - kLast); index < n; index += 1) keep.add(index)

  const critical = new Set<number>()

  if (allStrings) {
    items.forEach((item, index) => {
      if (hasErrorKeyword(String(item))) {
        keep.add(index)
        critical.add(index)
      }
    })
  } else {
    const numbers = items.filter(
      (item): item is number => typeof item === 'number' && Number.isFinite(item)
    )
    if (numbers.length > 0) {
      const average = mean(numbers)
      const stdev = sampleStdev(numbers)
      if (stdev > 0) {
        const threshold = VARIANCE_THRESHOLD * stdev
        items.forEach((item, index) => {
          if (typeof item !== 'number' || !Number.isFinite(item)) return
          if (Math.abs(item - average) > threshold) {
            keep.add(index)
            critical.add(index)
          }
        })
      }
      const series = numbers.map((value, row) => ({ row, value }))
      for (const point of detectChangePoints(series)) {
        for (const offset of [-1, 0, 1]) {
          const index = point + offset
          if (index < 0 || index >= n) continue
          keep.add(index)
          critical.add(index)
        }
      }
    }
  }

  const selected = prioritizeIndices({
    keep,
    items,
    effectiveMax: adaptiveK,
    critical: [...critical].sort((a, b) => a - b),
  })

  if (selected.size >= n) return unchanged('none:nothing_dropped')

  const keptIndices = [...selected].sort((a, b) => a - b)
  const rendered = renderScalarCrush(items, keptIndices, options)
  if (!rendered) return unchanged('ccr_unavailable')

  return {
    text: rendered.text,
    changed: true,
    ccrHash: rendered.hash,
    strategy: `${allStrings ? 'string' : 'number'}:adaptive(${n}->${keptIndices.length})`,
  }
}

/** Maximum nesting depth walked looking for arrays. */
const MAX_DOCUMENT_DEPTH = 8

/** Path of object keys / array indices from the root to the array being crushed. */
type DocumentPath = Array<string | number>

interface DocumentCrush {
  /** Order in which arrays were reached; only used for the strategy label. */
  arraysTried: number
  arraysCrushed: number
  hashes: string[]
  strategies: string[]
  /** Total rows before/after across every crushed array. */
  rowsBefore: number
  rowsAfter: number
}

/**
 * Walk a parsed document, crushing every array that can be crushed.
 *
 * The result is built by REPLACING whole subtrees, never by mutating in place,
 * so a caller that abandons the compression still holds the original document.
 *
 * Depth is bounded: a live-zone block is one tool result, so anything deeper
 * than a handful of levels is structural noise, and an unbounded walk is a
 * denial-of-service surface on a hostile payload.
 */
function walkDocument(
  value: unknown,
  options: SmartCrushOptions,
  stats: DocumentCrush,
  depth: number
): unknown {
  if (depth > MAX_DOCUMENT_DEPTH) return value

  if (Array.isArray(value)) {
    stats.arraysTried += 1

    // Crush this array itself first. `crushJsonArray` takes text, so the array
    // is re-serialized — cheap (microseconds) and it keeps one code path for
    // both shapes rather than a second, subtly different array implementation.
    const serialized = JSON.stringify(value)
    const crushed = crushJsonArray(serialized, options)
    if (crushed.changed) {
      stats.arraysCrushed += 1
      stats.strategies.push(crushed.strategy)
      if (crushed.ccrHash) stats.hashes.push(crushed.ccrHash)

      // Count the rows the array gained/lost from the sentinel the crush
      // appended, so the caller can report a real row delta.
      const after = JSON.parse(crushed.text) as unknown[]
      stats.rowsBefore += value.length
      stats.rowsAfter += after.length
      return after
    }

    // Not crushable as a whole: descend into its elements, because the
    // compressible records may be nested one level lower (arrays of wrappers).
    let changed = false
    const mapped = value.map(element => {
      const next = walkDocument(element, options, stats, depth + 1)
      if (next !== element) changed = true
      return next
    })
    return changed ? mapped : value
  }

  if (value && typeof value === 'object') {
    let changed = false
    const record = value as Record<string, unknown>
    const mapped: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(record)) {
      const next = walkDocument(entry, options, stats, depth + 1)
      if (next !== entry) changed = true
      mapped[key] = next
    }
    // Return the ORIGINAL object when nothing below changed, so a no-op walk
    // cannot alter a single byte of the surrounding document.
    return changed ? mapped : value
  }

  return value
}

/**
 * Compress a JSON *document* — an object whose compressible payload sits in
 * nested arrays.
 *
 * Real tool results are overwhelmingly this shape (MCP and HTTP APIs wrap their
 * records), so an array-only compressor misses most of the traffic it was built
 * for.
 *
 * The rules that make this safe:
 *
 * - a field that changed nothing is returned by identity, and the whole
 *   document is only re-serialized when at least one array actually shrank;
 * - a document that already carries a marker is left alone, or the walk would
 *   treat compressed output as source;
 * - only the live zone ever reaches this function.
 */
export function crushJsonDocument(text: string, options: SmartCrushOptions): SmartCrushResult {
  if (text.length < MIN_ARRAY_BYTES) return unchanged('below_min_bytes')
  if (isAlreadyCompressed(text)) return unchanged('already_compressed')

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return unchanged('not_json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return unchanged('not_document')
  }

  const stats: DocumentCrush = {
    arraysTried: 0,
    arraysCrushed: 0,
    hashes: [],
    strategies: [],
    rowsBefore: 0,
    rowsAfter: 0,
  }

  const walked = walkDocument(parsed, options, stats, 0)

  // Nothing actually shrank: forward the original text untouched rather than a
  // re-serialized copy that differs only in whitespace.
  if (stats.arraysCrushed === 0) return unchanged('no_nested_crush')

  const rendered = JSON.stringify(walked)
  if (rendered.length >= text.length) return unchanged('not_smaller')

  return {
    text: rendered,
    changed: true,
    ccrHash: stats.hashes[0],
    strategy: `document(${stats.arraysCrushed} of ${stats.arraysTried} arrays, ${stats.rowsBefore}->${stats.rowsAfter} rows)`,
  }
}
