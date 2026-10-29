/**
 * Content-type detection.
 *
 * Ported subset of headroom's `content_detector.py` cascade. The original tries
 * eleven classes with per-class confidence floors; this port keeps the classes
 * that change what we do (JSON, search results, build logs) plus the ones that
 * must NOT be mistaken for them (diff, HTML, source code), and folds the rest
 * (git status, tabular, structured config, fixed-width tables) into
 * `plain_text`, which is never compressed. A misclassification there costs
 * nothing; a misclassification of logs or JSON would cost correctness, so
 * those keep their own classes and confidence floors.
 *
 * Detection is a pure function of the text: no I/O, no regex state, and it must
 * be deterministic so the same payload always routes the same way.
 */

import type { ContentType } from './types.ts'

export interface DetectionResult {
  type: ContentType
  confidence: number
}

const PLAIN: DetectionResult = { type: 'plain_text', confidence: 0.5 }

/** Attempts a JSON array parse. Returns null when the text is not a JSON array. */
function tryJsonArray(text: string): DetectionResult | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('[')) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return Array.isArray(parsed) ? { type: 'json_array', confidence: 1 } : null
  } catch {
    // Truncated / mid-stream JSON is NOT a JSON array. Falling back instead of
    // claiming the class is what keeps a partially written tool output from
    // being handed to the array crusher, which would return no savings and
    // mask a real parse failure.
    return null
  }
}

/**
 * A whole JSON object document.
 *
 * This is the shape most tool results actually take: MCP servers and ordinary
 * HTTP APIs wrap their payload, so the compressible records sit one level down
 * (`{"results":[...]}`, `{"data":[...]}`, `{"issues":[...]}`). Without this
 * class such a payload was detected as `plain_text` and never compressed at
 * all.
 *
 * Only the FULL text must parse: a prefix that merely starts with `{` (a log
 * line containing braces, a truncated body) is not a document and must not
 * claim the class.
 */
function tryJsonDocument(text: string): DetectionResult | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { type: 'json_document', confidence: 1 }
    }
    return null
  } catch {
    return null
  }
}

const DIFF_HEADER = /^diff --git /m
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m

function tryDiff(text: string): DetectionResult | null {
  if (!DIFF_HEADER.test(text) && !HUNK_HEADER.test(text)) return null
  return { type: 'git_diff', confidence: 0.9 }
}

const HTML_DOCTYPE = /^\s*<!doctype\s+html/i
const HTML_TAG = /<html[\s>]/i

function tryHtml(text: string): DetectionResult | null {
  if (HTML_DOCTYPE.test(text) || HTML_TAG.test(text)) {
    return { type: 'html', confidence: 0.9 }
  }
  return null
}

/**
 * `file:123:content` (grep) or `file-123-content` (ripgrep context output).
 * A single regex with a backreference for the separator: the lazy path group
 * lets a Windows drive prefix (`C:\src\a.ts:42:...`) resolve by backtracking,
 * and filename dashes (`pre-commit.yaml-42-...`) are absorbed by the same
 * backtracking because the separator must be followed by digits.
 */
const SEARCH_LINE = /^(.+?)([:-])(\d+)\2\S?/

function trySearchResults(text: string): DetectionResult | null {
  const lines = text.split('\n')
  let considered = 0
  let matched = 0
  for (const line of lines) {
    if (!line.trim()) continue
    considered += 1
    if (SEARCH_LINE.test(line)) matched += 1
    if (considered >= 40) break
  }
  if (considered === 0) return null
  const ratio = matched / considered
  if (ratio >= 0.6) return { type: 'search_results', confidence: ratio }
  return null
}

const LOG_LEVEL = /\b(?:ERROR|FATAL|CRITICAL|FAIL|FAILED|WARN|WARNING|INFO|DEBUG|TRACE)\b/
const LOG_LEVEL_UPPER = /^(?:ERROR|FATAL|CRITICAL|FAILED|WARNING|INFO|DEBUG|TRACE)\b/
const STACK_TRACE =
  /^(?:Traceback \(most recent call last\)|at .+\(.+:\d+:\d+\)|\s+at [\w.$/]+\(|thread '.*' panicked at|panic: |Exception in thread)/
const SUMMARY_LINE =
  /^(?:===|---|\d+ (?:passed|failed|skipped|error|warning)\b|Tests?: \d|Suite: \d|TOTAL\b|Summary\b)/

function tryBuildOutput(text: string): DetectionResult | null {
  const lines = text.split('\n')
  let considered = 0
  let signals = 0
  for (const line of lines) {
    if (!line.trim()) continue
    considered += 1
    if (
      LOG_LEVEL.test(line) ||
      LOG_LEVEL_UPPER.test(line) ||
      STACK_TRACE.test(line) ||
      SUMMARY_LINE.test(line)
    ) {
      signals += 1
    }
    if (considered >= 100) break
  }
  if (considered === 0) return null
  const ratio = signals / considered
  if (ratio >= 0.15) return { type: 'build_output', confidence: Math.min(0.95, 0.5 + ratio) }
  return null
}

const CODE_SIGNALS = [
  /^\s*(?:import|from|export|require|package|use|using|namespace)\s/m,
  /^\s*(?:def|class|function|func|fn|pub fn|interface|type|struct|enum)\s+\w+/m,
  /=>|\bfunction\s*\(|\(\s*\)\s*\{/,
  /^\s*(?:if|for|while|switch|try|catch)\s*[({]/m,
  /;\s*$/m,
  /^\s*(?:\/\/|#|\/\*|\*)\s/m,
]

function trySourceCode(text: string): DetectionResult | null {
  let hits = 0
  for (const pattern of CODE_SIGNALS) {
    if (pattern.test(text)) hits += 1
  }
  if (hits >= 3) return { type: 'source_code', confidence: 0.5 + hits * 0.1 }
  if (hits === 2) return { type: 'source_code', confidence: 0.5 }
  return null
}

/**
 * Classify one block of text. Order and confidence floors follow the upstream
 * cascade: JSON first (it is the highest-value class), then the distinctive
 * formats, then the heuristic ones.
 */
export function detectContentType(text: string): DetectionResult {
  if (!text || !text.trim()) return PLAIN

  // JSON claims first, in both its shapes: a full parse is the strongest
  // evidence available, and a payload that parses must not be misread as a
  // search result or a log just because it contains colons or ERROR strings.
  const json = tryJsonArray(text)
  if (json) return json

  const jsonDocument = tryJsonDocument(text)
  if (jsonDocument) return jsonDocument

  const diff = tryDiff(text)
  if (diff) return diff

  const html = tryHtml(text)
  if (html) return html

  const search = trySearchResults(text)
  if (search) return search

  const log = tryBuildOutput(text)
  if (log) return log

  const code = trySourceCode(text)
  if (code) return code

  return PLAIN
}
