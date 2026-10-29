/**
 * Cross-turn duplication measurement — OBSERVATION ONLY.
 *
 * A coding agent re-displays the same bytes constantly: `cat`, then `sed`, then
 * `git diff`, then `cat` again. Across a conversation a good share of the prompt
 * is the same text several times over. Collapsing those repeats is the one
 * remaining saving this proxy has not looked at.
 *
 * Whether it is worth doing depends on a number we do not have: how many bytes
 * are actually duplicated, and how that compares to the cached suffix we would
 * have to invalidate by rewriting them. This module produces exactly that first
 * number and nothing else.
 *
 * Three properties, all deliberate:
 *
 * 1. **It never changes a single byte.** It reads the message array and returns
 *    a count. There is no `apply`, no mutation, no return value that a caller
 *    could forward upstream. That is the whole reason it is safe to leave on.
 * 2. **It is free on the traffic we currently have.** With fewer than two
 *    blocks above the size floor there is nothing to compare, so a single-turn
 *    request exits after one pass over its lengths — which is every request in
 *    the current logs. It starts costing anything only when multi-turn agent
 *    traffic shows up, which is exactly when the answer becomes interesting.
 * 3. **Every bound is explicit.** Byte budget, block budget, run length and a
 *    deadline all cap the work; `truncated` says the scan stopped early so a
 *    partial number is never mistaken for the whole prompt.
 *
 * The matching rule follows headroom's `cross_turn_dedup`:
 * - a run must be contiguous on BOTH sides and come from a single strictly
 *   earlier message (so the earliest copy is never the one folded);
 * - a uniform line offset is tolerated, because a re-read after an edit shifts
 *   every line number while the text stays identical;
 * - a run only counts when it clears both a line minimum and a char minimum,
 *   so two lines that happen to start the same way are not called a duplicate.
 */

import type { ChatMessage } from '../types'

/** A block below this size is not worth comparing. */
const MIN_BLOCK_CHARS = 512
/** Two blocks are needed before cross-turn comparison is meaningful. */
const MIN_COMPARABLE_BLOCKS = 2
/** Total bytes examined per request. */
const MAX_SCANNED_CHARS = 256 * 1024
/** Blocks examined per request (the newest ones win). */
const MAX_BLOCKS = 40
/** Wall-clock ceiling for one measurement. */
const MEASUREMENT_DEADLINE_MS = 50
/** A foldable run must be at least this many lines... */
const MIN_RUN_LINES = 3
/** ...and at least this many characters. */
const MIN_RUN_CHARS = 40
/** Candidate anchors kept per line key, in first-seen order. */
const MAX_ANCHOR_CANDIDATES = 16
/** Longest run extension attempted from one anchor. */
const MAX_RUN_SCAN = 200
/** Lines are added to the anchor index in this order, so the first copy wins. */
const NEWLINE_WEIGHT = 1

export interface DuplicationStats {
  /** Messages that cleared the size floor and were compared. */
  blocks: number
  /** Characters actually examined (after the caps). */
  scannedChars: number
  /** Characters that could be folded if every verbatim repeat collapsed. */
  duplicatedChars: number
  /** Number of qualifying runs. */
  runs: number
  /** Longest contiguous duplicated run, in lines. */
  longestRunLines: number
  /** True when a cap stopped the scan before the whole prompt. */
  truncated: boolean
}

const EMPTY: DuplicationStats = {
  blocks: 0,
  scannedChars: 0,
  duplicatedChars: 0,
  runs: 0,
  longestRunLines: 0,
  truncated: false,
}

/**
 * Normalize one line into a match key.
 *
 * Leading line numbers are stripped so a file that was edited and re-read still
 * matches its earlier copy when the text itself did not change — the same
 * uniform-offset tolerance the upstream algorithm needs. Internal whitespace is
 * collapsed because a re-print through a different tool often re-wraps.
 *
 * Only the unambiguous line-number forms are stripped: `N:` (grep -n, sed) and
 * `N<TAB>` (column output). A bare space after the digits is deliberately NOT
 * treated as a line number, because prose ("1 apple", "2 apples") would then
 * collapse to the same key and two unrelated sentences would be counted as a
 * duplicate.
 */
export function normalizeLineKey(line: string): string {
  return line
    .replace(/\r$/, '')
    .replace(/^\s*\d+:\s*/, '')
    .replace(/^\s*\d+\t\s*/, '')
    .replace(/^\s*[>|]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The text a message offers for comparison, or null when it is not text. */
function messageText(message: ChatMessage): string | null {
  if (typeof message.content === 'string') {
    return message.content.length > 0 ? message.content : null
  }
  if (!Array.isArray(message.content)) return null

  const parts: string[] = []
  for (const part of message.content) {
    if (part && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text)
    }
  }
  return parts.length > 0 ? parts.join('\n') : null
}

interface Block {
  /** Message index, used only for ordering. */
  index: number
  lines: string[]
  /** Line keys, parallel to `lines`. */
  keys: string[]
}

/**
 * Measure how much of a request is verbatim duplication of earlier content.
 *
 * Returns zeros — cheaply — whenever there is nothing to compare.
 */
export function measureCrossTurnDuplication(
  messages: ChatMessage[] | undefined
): DuplicationStats {
  if (!Array.isArray(messages) || messages.length < 2) return EMPTY

  // Pass 1: collect blocks that clear the floor, newest-last.
  const candidates: Array<{ index: number; text: string }> = []
  for (let index = 0; index < messages.length; index += 1) {
    const text = messageText(messages[index])
    if (text && text.length >= MIN_BLOCK_CHARS) {
      candidates.push({ index, text })
    }
  }
  if (candidates.length < MIN_COMPARABLE_BLOCKS) return EMPTY

  // Keep the NEWEST blocks: in a long conversation the recent tool outputs are
  // where repetition happens, and the oldest blocks are the ones most likely to
  // have been cached already.
  const selected = candidates.slice(-MAX_BLOCKS)

  const deadline = Date.now() + MEASUREMENT_DEADLINE_MS
  let truncated = false
  let scannedChars = 0
  const blocks: Block[] = []
  let lineCount = 0

  // Pass 2: split into lines, respecting the byte and line budgets.
  for (const candidate of selected) {
    if (scannedChars >= MAX_SCANNED_CHARS) {
      truncated = true
      break
    }

    const budget = MAX_SCANNED_CHARS - scannedChars
    const text = candidate.text.length > budget ? candidate.text.slice(0, budget) : candidate.text
    if (text.length < candidate.text.length) truncated = true
    scannedChars += text.length

    const rawLines = text.split('\n')
    const lines: string[] = []
    const keys: string[] = []
    for (const rawLine of rawLines) {
      const key = normalizeLineKey(rawLine)
      if (key.length === 0) continue
      lines.push(rawLine)
      keys.push(key)
    }
    if (lines.length === 0) continue

    blocks.push({ index: candidate.index, lines, keys })
    lineCount += lines.length
  }

  if (blocks.length < MIN_COMPARABLE_BLOCKS || lineCount === 0) return EMPTY

  // Anchor index: line key -> the first few (block, line) occurrences, in
  // first-seen order. Only EARLIER blocks are present at any moment, which is
  // what makes the earliest copy unfoldable by construction.
  const anchors = new Map<string, Array<{ block: number; line: number }>>()
  let duplicatedChars = 0
  let runs = 0
  let longestRunLines = 0

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    if (Date.now() > deadline) {
      truncated = true
      break
    }

    const block = blocks[blockIndex]
    let lineIndex = 0

    while (lineIndex < block.keys.length) {
      const key = block.keys[lineIndex]
      const candidatesAtKey = anchors.get(key)
      if (!candidatesAtKey || candidatesAtKey.length === 0) {
        lineIndex += 1
        continue
      }

      let bestLines = 0
      let bestChars = 0

      for (const anchor of candidatesAtKey) {
        let runLines = 0
        let runChars = 0

        // Comparing key[i + n] with anchorKey[n] tolerates ANY constant line
        // offset: a re-read after an edit renumbers the file while the text
        // stays identical, and that is still a verbatim duplicate.
        while (
          runLines < MAX_RUN_SCAN &&
          lineIndex + runLines < block.keys.length &&
          anchor.line + runLines < blocks[anchor.block].keys.length
        ) {
          if (block.keys[lineIndex + runLines] !== blocks[anchor.block].keys[anchor.line + runLines]) {
            break
          }
          runChars += block.lines[lineIndex + runLines].length + NEWLINE_WEIGHT
          runLines += 1
        }

        if (runLines > bestLines) {
          bestLines = runLines
          bestChars = runChars
        }
      }

      if (bestLines >= MIN_RUN_LINES && bestChars >= MIN_RUN_CHARS) {
        duplicatedChars += bestChars
        runs += 1
        if (bestLines > longestRunLines) longestRunLines = bestLines
        // Skip past the folded run so the same bytes are not counted twice.
        lineIndex += bestLines
      } else {
        lineIndex += 1
      }
    }

    // Only now does this block become available as a fold target, so a run can
    // never match against its own copy or a later one.
    for (let index = 0; index < block.keys.length; index += 1) {
      const key = block.keys[index]
      const list = anchors.get(key)
      if (!list) {
        anchors.set(key, [{ block: blockIndex, line: index }])
        continue
      }
      if (list.length < MAX_ANCHOR_CANDIDATES) {
        list.push({ block: blockIndex, line: index })
      }
    }
  }

  return {
    blocks: blocks.length,
    scannedChars,
    duplicatedChars,
    runs,
    longestRunLines,
    truncated,
  }
}

/**
 * Per-request handoff, mirroring the compression report registry.
 *
 * The forwarder measures; the route owns the log row. Keeping this separate from
 * `compression` matters because measurement must be recorded even when
 * compression is disabled — that is the normal case, and the whole point is to
 * observe traffic before deciding whether to act on it.
 */
const measurements = new Map<string, DuplicationStats>()
const MAX_PENDING = 256

export function recordDuplication(requestId: string, stats: DuplicationStats): void {
  if (!requestId) return
  if (measurements.size >= MAX_PENDING) {
    const oldest = measurements.keys().next()
    if (!oldest.done) measurements.delete(oldest.value)
  }
  measurements.set(requestId, stats)
}

export function takeDuplication(requestId: string): DuplicationStats | undefined {
  const stats = measurements.get(requestId)
  if (stats) measurements.delete(requestId)
  return stats
}
