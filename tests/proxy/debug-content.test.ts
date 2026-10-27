import { test } from 'node:test'
import assert from 'node:assert/strict'

import { debugContent, setContentLoggingEnabled } from '../../src/main/proxy/utils/debugContent.ts'

test('content logging stays silent unless the body-logging switch is on', () => {
  const lines: unknown[][] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args)
  }
  try {
    setContentLoggingEnabled(false)
    debugContent('[T]', 'hello world', 5)
    assert.equal(lines.length, 0)

    setContentLoggingEnabled(true)
    debugContent('[T]', 'hello world', 5)
    debugContent('[T]', 'ab', 5)
    debugContent('[T]', { a: 1 }, 100)
    debugContent('[T]', undefined, 10)

    assert.deepEqual(lines, [
      ['[T]', 'hello...'],
      ['[T]', 'ab'],
      ['[T]', '{"a":1}'],
      ['[T]', ''],
    ])
  } finally {
    console.log = original
    setContentLoggingEnabled(false)
  }
})

test('disabling again silences a logger that was previously enabled', () => {
  const lines: unknown[][] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args)
  }
  try {
    setContentLoggingEnabled(true)
    debugContent('[T]', 'first', 50)
    setContentLoggingEnabled(false)
    debugContent('[T]', 'second', 50)
    assert.deepEqual(lines, [['[T]', 'first']])
  } finally {
    console.log = original
  }
})
