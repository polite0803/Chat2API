/**
 * Adaptive retention sizing.
 *
 * Answers one question: given N comparable items (JSON rows, log lines, search
 * hits), how many are worth keeping? The answer is derived from how much
 * *information* the items carry, not from a fixed ratio and not from the
 * model's context window — a duplicate-heavy payload compresses far harder than
 * a payload where every row is distinct.
 *
 * Ported from headroom's `adaptive_sizer.py` / `adaptive_sizer.rs`:
 *
 *   1. tiny payloads (`n <= 8`) keep everything;
 *   2. near-total redundancy (<= 3 distinct items) keeps only those;
 *   3. otherwise find the knee of the cumulative unique-bigram coverage curve;
 *   4. no knee -> scale retention with diversity (`0.3 + 0.7 * diversity`);
 *   5. multiply by `bias` (the aggressiveness dial) and clamp.
 *
 * The zlib validation step from the original is kept: if the retained subset
 * compresses very differently from the full set, the subset is not
 * representative and the budget is raised by 20%.
 */

import { deflateRawSync } from 'zlib'

export interface OptimalKOptions {
  /** Multiplies the knee. 1.5 = keep more, 0.7 = keep less. */
  bias?: number
  minK?: number
  maxK?: number
}

/** Knee must clear this deviation from the diagonal to count (headroom: 0.05). */
const KNEE_MIN_DEVIATION = 0.05
/** zlib check: tolerance on the compressed-ratio delta. */
const ZLIB_TOLERANCE = 0.15
const ZLIB_MIN_BYTES = 200
const ZLIB_MAX_BYTES = 256 * 1024
const ZLIB_MAX_ITEMS = 2000

/** FNV-1a over UTF-16 code units; deterministic and allocation-free. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(word => word.length > 0)
}

function shingles(text: string, width: number): string[] {
  const parts = words(text)
  if (parts.length === 0) return []
  if (parts.length < width) return [parts.join(' ')]
  const result: string[] = []
  for (let index = 0; index + width <= parts.length; index += 1) {
    result.push(parts.slice(index, index + width).join(' '))
  }
  return result
}

/** 32-bit SimHash over 3-word shingles. */
function simhash(text: string): number {
  const features = shingles(text, 3)
  if (features.length === 0) return fnv1a32(text)
  const vector = new Array<number>(32).fill(0)
  for (const feature of features) {
    const hash = fnv1a32(feature)
    for (let bit = 0; bit < 32; bit += 1) {
      vector[bit] += (hash >>> bit) & 1 ? 1 : -1
    }
  }
  let result = 0
  for (let bit = 0; bit < 32; bit += 1) {
    if (vector[bit] > 0) result |= 1 << bit
  }
  return result >>> 0
}

function popcount32(value: number): number {
  let count = 0
  let current = value >>> 0
  while (current !== 0) {
    current &= current - 1
    count += 1
  }
  return count
}

/** Number of distinct items after grouping near-duplicates (Hamming <= threshold). */
export function countUniqueSimhash(items: readonly string[], threshold = 3): number {
  if (items.length === 0) return 0
  const representatives: number[] = []
  for (const item of items) {
    const hash = simhash(item)
    let seen = false
    for (const representative of representatives) {
      if (popcount32((hash ^ representative) >>> 0) <= threshold) {
        seen = true
        break
      }
    }
    if (!seen) representatives.push(hash)
  }
  return representatives.length
}

/**
 * Index (1-based count) of the knee of the cumulative unique-bigram coverage
 * curve, or null when the curve is not meaningfully concave.
 */
function findKnee(items: readonly string[]): number | null {
  const n = items.length
  if (n === 0) return null

  const seen = new Set<string>()
  const cumulative = new Array<number>(n).fill(0)
  let total = 0

  for (let index = 0; index < n; index += 1) {
    const features = shingles(items[index], 2)
    for (const feature of features) {
      if (!seen.has(feature)) {
        seen.add(feature)
        total += 1
      }
    }
    cumulative[index] = total
  }

  if (total === 0) return null

  let bestDeviation = 0
  let bestIndex = -1
  for (let index = 0; index < n; index += 1) {
    const coverage = cumulative[index] / total
    const position = (index + 1) / n
    const deviation = coverage - position
    if (deviation > bestDeviation) {
      bestDeviation = deviation
      bestIndex = index
    }
  }

  if (bestIndex < 0 || bestDeviation < KNEE_MIN_DEVIATION) return null
  return bestIndex + 1
}

/**
 * zlib sanity check: is the retained prefix representative of the whole set?
 * Only runs on payloads small enough for the cost to be irrelevant.
 */
function zlibAdjust(items: readonly string[], k: number, effectiveMax: number): number {
  const n = items.length
  if (k >= n || n > ZLIB_MAX_ITEMS) return k

  const full = items.join('\n')
  if (full.length < ZLIB_MIN_BYTES || full.length > ZLIB_MAX_BYTES) return k

  const subset = items.slice(0, k).join('\n')
  if (subset.length === 0) return k

  try {
    const fullRatio = deflateRawSync(full).length / Buffer.byteLength(full, 'utf8')
    const subsetRatio = deflateRawSync(subset).length / Buffer.byteLength(subset, 'utf8')
    if (Math.abs(fullRatio - subsetRatio) > ZLIB_TOLERANCE) {
      return Math.min(effectiveMax, Math.ceil(k * 1.2))
    }
  } catch {
    // zlib unavailable or payload rejected: the check is advisory only.
  }
  return k
}

/**
 * Number of items to retain out of `items`.
 *
 * Always returns a value in `[minK, min(n, maxK)]` (or `n` when `n` is below
 * `minK`, so a small payload is never inflated).
 */
export function computeOptimalK(
  items: readonly string[],
  options: OptimalKOptions = {}
): number {
  const n = items.length
  if (n === 0) return 0

  const bias = Number.isFinite(options.bias) && (options.bias as number) > 0 ? (options.bias as number) : 1
  const minK = Math.max(1, options.minK ?? 3)
  const maxK = options.maxK ?? n
  const effectiveMax = Math.min(n, Math.max(1, maxK))
  const floor = Math.min(minK, effectiveMax)

  // 1. Tiny payloads: nothing to gain, and sampling them loses fidelity.
  if (n <= 8) return effectiveMax

  // 2. Near-total redundancy: keep the distinct items, not a fraction of them.
  const uniqueCount = countUniqueSimhash(items, 3)
  if (uniqueCount <= 3) {
    return Math.max(floor, Math.min(uniqueCount, effectiveMax))
  }

  const diversity = uniqueCount / n
  const diversityFloor = Math.max(floor, Math.floor(n * (0.3 + 0.7 * diversity)))

  // 3. Knee of the coverage curve.
  const knee = findKnee(items)
  let k: number
  if (knee === null) {
    // 4. No meaningful knee: scale with diversity.
    k = diversityFloor
  } else {
    k = Math.max(floor, Math.floor(knee * bias))
    // A highly diverse payload must not be cut below the diversity floor —
    // that is the case where every item is genuinely different.
    if (diversity > 0.7) k = Math.max(k, diversityFloor)
  }

  k = Math.min(effectiveMax, Math.max(floor, k))

  // 5. zlib validation.
  return zlibAdjust(items, k, effectiveMax)
}
