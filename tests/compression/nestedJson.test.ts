import { test } from 'node:test'
import assert from 'node:assert/strict'

import { crushJsonDocument } from '../../src/main/proxy/compression/compressors/smartCrusher.ts'
import { detectContentType } from '../../src/main/proxy/compression/detector.ts'
import { isCcrSentinel } from '../../src/main/proxy/compression/ccr/markers.ts'

const stash = (original: string, idLength: number): string | null => 'a'.repeat(idLength)

function crush(document: unknown) {
  return crushJsonDocument(JSON.stringify(document), {
    maxKeptItems: 15,
    bias: 1,
    stash,
  })
}

/** A redundant record set large enough to clear every gate. */
function records(count: number, extra?: (index: number) => Record<string, unknown>) {
  return Array.from({ length: count }, (_, index) => ({
    id: index,
    path: `src/module-${index % 7}.ts`,
    line: index,
    match: 'export function handler()',
    status: 'ok',
    ...extra?.(index),
  }))
}

test('a document is detected as json_document, not plain_text', () => {
  assert.equal(detectContentType('{"results":[{"a":1},{"a":2}]}').type, 'json_document')
  // A top-level array keeps its own class.
  assert.equal(detectContentType('[{"a":1},{"a":2}]').type, 'json_array')
  // A brace-containing log line is not a document: the whole text must parse.
  assert.notEqual(detectContentType('{ "level": "info", trailing garbage').type, 'json_document')
  assert.notEqual(detectContentType('plain text starting with {brace').type, 'json_document')
})

test('nested arrays inside a wrapper object are compressed', () => {
  const document = {
    total: 300,
    results: records(300),
  }

  const result = crush(document)
  assert.equal(result.changed, true)

  const parsed = JSON.parse(result.text) as Record<string, unknown>
  const compressed = parsed.results as unknown[]
  const rows = compressed.filter(row => !isCcrSentinel(row))

  // The wrapper's own scalar field survives untouched.
  assert.equal(parsed.total, 300)
  // Rows were dropped, and the sentinel explains where they went.
  assert.ok(rows.length < 300)
  assert.equal(compressed.length, rows.length + 1)
})

test('the error row inside a nested array still survives', () => {
  const document = {
    results: records(300, index =>
      index === 150 ? { error: 'FATAL: unexpected token' } : {}
    ),
  }

  const result = crush(document)
  assert.equal(result.changed, true)
  assert.ok(result.text.includes('FATAL: unexpected token'))
})

test('several nested arrays are each compressed in one pass', () => {
  const document = {
    pages: [
      { results: records(200) },
      { results: records(200) },
    ],
  }

  const result = crush(document)
  assert.equal(result.changed, true)
  assert.match(result.strategy, /document\(2 of /)
})

test('a document with nothing compressible is returned byte-identical', () => {
  // Arrays exist but are far too small to be worth touching.
  const document = { a: [1, 2, 3], b: { c: ['x', 'y'] }, note: 'small payload' }
  const result = crush(document)

  assert.equal(result.changed, false)
  assert.equal(result.text, '')
})

test('scalars and empty containers elsewhere in the document are untouched', () => {
  const document = {
    count: 0,
    flag: false,
    nothing: null,
    empty: [],
    emptyObject: {},
    results: records(300),
  }

  const parsed = JSON.parse(crush(document).text) as Record<string, unknown>

  assert.equal(parsed.count, 0)
  assert.equal(parsed.flag, false)
  assert.equal(parsed.nothing, null)
  assert.deepEqual(parsed.empty, [])
  assert.deepEqual(parsed.emptyObject, {})
})

test('an already-compressed document is never compressed twice', () => {
  const first = crush({ results: records(300) })
  assert.equal(first.changed, true)

  const second = crushJsonDocument(first.text, { maxKeptItems: 15, bias: 1, stash })
  assert.equal(second.changed, false)
})

test('deep nesting does not recurse unbounded', () => {
  // Build a chain deeper than the walk limit; it must not throw or hang.
  let node: unknown = records(300)
  for (let depth = 0; depth < 20; depth += 1) node = { child: node }

  const result = crushJsonDocument(JSON.stringify(node), { maxKeptItems: 15, bias: 1, stash })
  // Beyond the depth cap nothing is reached, so the document is left alone.
  assert.equal(result.changed, false)
})

test('a failing stash refuses the whole document compression', () => {
  const result = crushJsonDocument(JSON.stringify({ results: records(300) }), {
    maxKeptItems: 15,
    bias: 1,
    stash: () => null,
  })

  assert.equal(result.changed, false)
})

test('top-level arrays and documents route to different entry points', () => {
  // Guard against the document path silently swallowing plain arrays.
  assert.equal(crush([1, 2, 3]).changed, false)
  assert.equal(crush('not json').changed, false)
  assert.equal(crush({}).changed, false)
})
