/**
 * Error keyword signals.
 *
 * Two different matching rules are used on purpose, because the two call sites
 * have opposite failure costs:
 *
 * - **Preservation** (keeping a JSON row, keeping a log line) must never miss.
 *   It uses a case-insensitive substring test, exactly like headroom's
 *   `error_keywords.rs`. A false positive only keeps a row we could have
 *   dropped; a false negative silently deletes the one line the user needed.
 * - **Classification** (is this line an error, a warning, …) uses an ASCII
 *   word-boundary test so `panicker` and `errorless` do not classify.
 *
 * The keyword sets are headroom's (`signals/keyword_detector.rs:78-118`), with
 * `token` deliberately absent from the security set: it false-positives on LLM
 * token metrics.
 */

/** Keywords that pin a row or line. Substring, case-insensitive. */
export const ERROR_PRESERVATION_KEYWORDS = [
  'error',
  'exception',
  'failed',
  'failure',
  'critical',
  'fatal',
  'crash',
  'panic',
  'abort',
  'timeout',
  'denied',
  'rejected',
] as const

/** Text-level classification sets. */
export const KEYWORD_SETS = {
  error: [
    'error',
    'exception',
    'fail',
    'failed',
    'failure',
    'fatal',
    'critical',
    'crash',
    'panic',
    'abort',
    'timeout',
    'denied',
    'rejected',
  ],
  warning: ['warning', 'warn'],
  importance: ['important', 'note', 'todo', 'fixme', 'hack', 'bug', 'fix'],
  security: ['security', 'auth', 'password', 'secret'],
} as const

export type KeywordCategory = keyof typeof KEYWORD_SETS

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const CLASSIFY_PATTERNS: Record<KeywordCategory, RegExp> = {
  error: new RegExp(`\\b(?:${KEYWORD_SETS.error.map(escapeRegExp).join('|')})\\b`, 'i'),
  warning: new RegExp(`\\b(?:${KEYWORD_SETS.warning.map(escapeRegExp).join('|')})\\b`, 'i'),
  importance: new RegExp(`\\b(?:${KEYWORD_SETS.importance.map(escapeRegExp).join('|')})\\b`, 'i'),
  security: new RegExp(`\\b(?:${KEYWORD_SETS.security.map(escapeRegExp).join('|')})\\b`, 'i'),
}

/**
 * True when `text` contains any preservation keyword.
 *
 * Callers pass already-lowercased text when they have it; this function
 * lowercases defensively so a missing `.toLowerCase()` can never turn into a
 * silently dropped error row.
 */
export function hasErrorKeyword(text: string): boolean {
  const lower = text.toLowerCase()
  for (const keyword of ERROR_PRESERVATION_KEYWORDS) {
    if (lower.includes(keyword)) return true
  }
  return false
}

/** Word-boundary classification of one line. Returns null when nothing matches. */
export function classifyKeyword(text: string): KeywordCategory | null {
  // Order is deliberate: error wins over every other category.
  for (const category of ['error', 'security', 'warning', 'importance'] as const) {
    if (CLASSIFY_PATTERNS[category].test(text)) return category
  }
  return null
}
