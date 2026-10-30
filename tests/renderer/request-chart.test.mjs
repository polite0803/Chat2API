import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const chartSource = readFileSync(
  join(root, 'src/renderer/src/components/dashboard/RequestChart.tsx'),
  'utf8',
)
const storeSource = readFileSync(
  join(root, 'src/renderer/src/stores/dashboardStore.ts'),
  'utf8',
)

test('a series that survives on one day is drawn as a marker', () => {
  assert.match(chartSource, /import \{ isolatedIndices \} from '@shared\/trendMath'/)
  assert.match(chartSource, /chart\.isolatedBySeries\[item\.key\]\.map/)
  assert.match(chartSource, /<circle[\s\S]*?r=\{item\.ring \? 5 : 2\.5\}/)
})

test('markers at the same coordinate do not hide each other', () => {
  // 10 requests / 10 successes sit on one point: the total is a ring so the
  // success dot stays visible inside it.
  assert.match(chartSource, /key: 'requests'[\s\S]*?ring: true/)
  assert.match(chartSource, /key: 'success'[\s\S]*?ring: false/)
  assert.match(chartSource, /fill=\{item\.ring \? 'none' : item\.color\}/)
})

test('markers do not replace breaking the line at a day with no retained data', () => {
  // Drawing the gap at 0 would claim the proxy served nothing that day.
  assert.match(chartSource, /if \(value === null\) \{\s*command = 'M'/)
  assert.match(chartSource, /chartRetentionGap/)
})

test('the trend is computed from the rollup the dashboard already fetched', () => {
  // A second channel for the same numbers turned "this build lacks the API" into
  // "there is no traffic" once already; the trend must not depend on one.
  assert.match(storeSource, /dailyTrendPoints\(persistentStats\.dailyStats, 7\)/)
  assert.match(storeSource, /persistentStats\?\.dailyStats\s*\n?\s*\? dailyTrendPoints/)
  assert.doesNotMatch(storeSource, /requestLogs\?\.getTrend|statistics\?\.getTrend/)
  assert.doesNotMatch(
    readFileSync(join(root, 'src/main/ipc/channels.ts'), 'utf8'),
    /statistics:getTrend/,
  )
})
