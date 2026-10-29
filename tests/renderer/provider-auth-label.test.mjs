/**
 * 供应商卡片上「认证方式」那一格。
 *
 * 两个缺陷叠在一起，任一单独修都不算修好：
 *
 * 1. **渠道按 `authType` 渲染会把网页登录说成 API Key。** `AuthType` 的八个
 *    枚举值里没有「浏览器/设备码登录」这一档，渠道记录只能填最接近的
 *    `token`，卡片照它渲染就显示 `API Key` —— 而那十二个渠道是靠网页/设备码
 *    登录拿账号的，根本没有 Key。事实来源是渠道目录的 `loginKind`。
 * 2. **标签是写死的英文。** 旧 `getAuthTypeLabel` 返回 `'API Key'` /
 *    `'User Token'` 这类字面量，中文界面上也照原样显示英文。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const card = read('src/renderer/src/components/providers/ProviderCard.tsx')
const form = read('src/renderer/src/components/providers/CustomProviderForm.tsx')
const manager = read('src/main/providers/accountChannels/manager.ts')

const locales = ['zh-CN', 'en-US'].map(name => ({
  name,
  providers: JSON.parse(read(`src/renderer/src/i18n/locales/${name}.json`)).providers,
  channels: JSON.parse(read(`src/renderer/src/i18n/locales/${name}.json`)).channels,
}))

/** `AuthType` 的八个枚举值，与 `src/shared/types.ts` 保持一致。 */
const AUTH_TYPES = [
  'oauth',
  'token',
  'cookie',
  'userToken',
  'refresh_token',
  'jwt',
  'realUserID_token',
  'tongyi_sso_ticket',
]

/** 渠道目录里的四种登录方式。 */
const LOGIN_KINDS = ['browser', 'device-code', 'sms', 'oauth']

test('渠道的「认证方式」取 loginKind，不取 authType', () => {
  // 卡片必须先看 type === 'account' 且 loginKind 存在，再退回 authType
  assert.match(card, /provider\.type === 'account' && provider\.loginKind !== undefined/,)
  assert.match(card, /channels\.loginKind\.\$\{provider\.loginKind\}/,
    '渠道登录方式必须读 channels.loginKind 那套文案')

  // 渠道目录的事实来源必须真的被写进记录，否则卡片读不到
  assert.match(manager, /loginKind: definition\?\.loginKind/,
    'applyChannel 要把 catalogue 的 loginKind 写进 provider 记录')
})

test('非渠道供应商仍按 authType 显示，但文案走 i18n', () => {
  assert.match(card, /providers\.authLabels\.\$\{provider\.authType\}/,
    '认证方式标签必须走 i18n，不能再用写死的英文')
  // 兜底保留，遇到未知枚举值时仍有可读文字
  assert.match(card, /defaultValue: getAuthTypeLabel\(provider\.authType\)/)
})

test('八个 authType 与四种 loginKind 在两个语言里都有文案', () => {
  for (const { name, providers, channels } of locales) {
    for (const authType of AUTH_TYPES) {
      const label = providers.authLabels?.[authType]
      assert.equal(typeof label, 'string', `${name} 缺 providers.authLabels.${authType}`)
      assert.ok(label.length > 0, `${name} 的 ${authType} 是空文案`)
    }
    for (const kind of LOGIN_KINDS) {
      const label = channels.loginKind?.[kind]
      assert.equal(typeof label, 'string', `${name} 缺 channels.loginKind.${kind}`)
    }
  }
})

test('自定义供应商表单不再引用不存在的文案键', () => {
  // 旧代码引用了 providers.authToken / authTokenDesc 等键，两个语言文件里
  // 一个都没有，t() 会原样回显键名（选择器里显示 providers.authToken）。
  for (const deadKey of [
    'providers.authToken"',
    'providers.authUserToken"',
    'providers.authRefreshToken"',
    'providers.authJwt"',
    'providers.authUserIdToken"',
    'providers.authSso"',
    'providers.authCookie"',
    'providers.authOAuth"',
  ]) {
    assert.ok(!form.includes(deadKey), `表单仍在引用不存在的键 ${deadKey}`)
  }
  // 标签统一从 authLabels 取
  assert.match(form, /providers\.authLabels\.\$\{option\.value\}/)

  // 描述文案必须真的存在
  const descKeys = [...form.matchAll(/descKey: '([^']+)'/g)].map(m => m[1])
  assert.ok(descKeys.length >= 8, `只找到 ${descKeys.length} 个 descKey`)
  for (const { name, providers } of locales) {
    for (const key of descKeys) {
      const short = key.replace(/^providers\./, '')
      assert.equal(typeof providers[short], 'string', `${name} 缺 ${key}`)
    }
  }
})

test('展示用的 loginKind 是可选字段：旧记录没有它也要能渲染', () => {
  // 卡片对 loginKind 缺失是显式分支，不是非空断言
  assert.doesNotMatch(card, /provider\.loginKind!\./, '不能用非空断言，旧记录没有这个字段')
})

test('目录拉空时也要带上 loginKind，卡片不能退回 API Key', () => {
  // `usable === false` 的早退分支（有账号但模型列表为空）曾只清模型字段，
  // 于是上游目录故障期间，渠道卡片的「认证方式」又变回 API Key。
  const body = manager.slice(
    manager.indexOf('if (!usable)'),
    manager.indexOf('// 改名前的目录快照'),
  )
  assert.match(body, /loginKind: getChannelDefinition\(id\)\?\.loginKind/,
    '早退分支必须同样写入 loginKind')
})
