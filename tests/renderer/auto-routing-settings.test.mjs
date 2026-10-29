import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

test('the settings panel reuses the shared auto-routing defaults instead of its own copy', () => {
  const panel = readFileSync(
    join(root, 'src/renderer/src/components/proxy/LoadBalanceConfig.tsx'),
    'utf8',
  )

  // 两处各自维护默认值就会漂移：渲染层必须取共享常量
  assert.match(panel, /DEFAULT_AUTO_ROUTING_CONFIG/)
  assert.doesNotMatch(panel, /stickyMinutes:\s*30\b/)
  // 偏好选择器要列出全部共享枚举，而不是手写一份选项数组
  assert.match(panel, /AUTO_PREFERENCES\.map/)
  assert.match(panel, /id="auto-prefer"/)
})

test('every preference has a translation in both locales', () => {
  for (const locale of ['zh-CN', 'en-US']) {
    const messages = JSON.parse(
      readFileSync(join(root, 'src/renderer/src/i18n/locales', `${locale}.json`), 'utf8'),
    )
    for (const key of [
      'autoRoutingPrefer',
      'autoRoutingPreferHelp',
      'autoRoutingPrefer_balanced',
      'autoRoutingPrefer_fast',
      'autoRoutingPrefer_strong',
      'autoRoutingPrefer_cheap',
    ]) {
      assert.equal(typeof messages.proxy?.[key], 'string', `${locale} is missing proxy.${key}`)
    }
  }
})
