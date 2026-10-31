import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

const component = () =>
  readFileSync(join(root, 'src/renderer/src/components/proxy/AdvancedConfig.tsx'), 'utf8')

const store = () =>
  readFileSync(join(root, 'src/renderer/src/stores/proxyStore.ts'), 'utf8')

test('the output-cap field writes the one config key the proxy reads', () => {
  const panel = component()

  assert.match(panel, /defaultMaxOutputTokens: outputCap/)
  // 留空 = 不写键：渲染层不得自己抄一份默认值，否则主进程改了默认，这里会把旧值当默认存进库
  assert.match(panel, /formData\.outputCap\.trim\(\) === '' \? undefined/)
  assert.doesNotMatch(panel, /defaultMaxOutputTokens\s*\?\?\s*\d+/, 'renderer must not re-declare the fallback')
  assert.match(panel, /id="outputCap"/)
  assert.match(store(), /defaultMaxOutputTokens: config\.defaultMaxOutputTokens,/)
})

test('every output-cap label has a translation in both locales', () => {
  for (const locale of ['zh-CN', 'en-US']) {
    const messages = JSON.parse(
      readFileSync(join(root, 'src/renderer/src/i18n/locales', `${locale}.json`), 'utf8'),
    )
    for (const key of [
      'outputCapFallback',
      'outputCapFallbackHelp',
      'outputCapMustBeInteger',
      'outputCapRangeError',
    ]) {
      assert.equal(typeof messages.proxy?.[key], 'string', `${locale} is missing proxy.${key}`)
    }
  }
})
