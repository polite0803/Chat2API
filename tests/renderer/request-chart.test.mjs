import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const chartSource = readFileSync(
  join(root, 'src/renderer/src/components/dashboard/RequestChart.tsx'),
  'utf8',
)

test('a series that survives on one day is drawn as a marker', () => {
  assert.match(chartSource, /import \{ isolatedIndices \} from '@shared\/trendMath'/)
  assert.match(chartSource, /chart\.isolatedBySeries\[item\.key\]\.map/)
  assert.match(chartSource, /<circle[\s\S]*?r=\{3\}/)
})

test('markers do not replace breaking the line at a day with no retained data', () => {
  // Drawing the gap at 0 would claim the proxy served nothing that day.
  assert.match(chartSource, /if \(value === null\) \{\s*command = 'M'/)
  assert.match(chartSource, /chartRetentionGap/)
})
