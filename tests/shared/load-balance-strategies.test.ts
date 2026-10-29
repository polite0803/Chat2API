import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 策略枚举在仓库里有四处独立字面量：`shared/types.ts`、`main/store/types.ts`、
 * `autoRouting.ts` 的口径枚举，以及 UI 的下拉列表与两张映射表。它们没有类型串接，
 * 加一个策略时漏掉任何一处，都只在运行时表现为"这个策略选不到/显示成 undefined"。
 * 这个测试把这些散点钉在一起：只要枚举里有，四处就必须都有。
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

const STRATEGIES = ['round-robin', 'fill-first', 'failover', 'smart', 'pace'] as const

test('every strategy is declared in both LoadBalanceStrategy unions', () => {
  for (const file of ['src/shared/types.ts', 'src/main/store/types.ts']) {
    const source = read(file)
    const match = source.match(/export type LoadBalanceStrategy = (.*)/)
    assert.ok(match, `${file} must declare LoadBalanceStrategy`)
    for (const strategy of STRATEGIES) {
      assert.ok(
        match![1].includes(`'${strategy}'`),
        `${file} is missing '${strategy}' in LoadBalanceStrategy`
      )
    }
  }
})

test('auto scoring accepts every strategy the balancer accepts', () => {
  const source = read('src/main/proxy/autoRouting.ts')
  const match = source.match(/export type AutoRoutingStrategy = (.*)/)
  assert.ok(match)
  for (const strategy of STRATEGIES) {
    assert.ok(
      match![1].includes(`'${strategy}'`),
      `AutoRoutingStrategy must accept '${strategy}', otherwise auto requests cannot use it`
    )
  }
})

test('the UI can select and label every strategy', () => {
  const source = read('src/renderer/src/components/proxy/LoadBalanceConfig.tsx')

  // 下拉列表：漏一项 = 这个策略永远选不到
  for (const strategy of STRATEGIES) {
    assert.ok(
      source.includes(`'${strategy}'`) && source.includes('as LoadBalanceStrategy[]'),
      `the strategy selector must offer '${strategy}'`
    )
  }

  // 两张映射表：漏一项 = 选中后标题显示成 undefined
  const labelEntries = (source.match(/labels: Record<LoadBalanceStrategy, string> = \{[\s\S]*?\n    \}/) ?? [])[0]
  const descEntries = (source.match(/descriptions: Record<LoadBalanceStrategy, string> = \{[\s\S]*?\n    \}/) ?? [])[0]
  assert.ok(labelEntries, 'strategy label map must exist')
  assert.ok(descEntries, 'strategy description map must exist')
  for (const strategy of STRATEGIES) {
    assert.ok(labelEntries.includes(`'${strategy}':`), `label map is missing '${strategy}'`)
    assert.ok(descEntries.includes(`'${strategy}':`), `description map is missing '${strategy}'`)
  }
})

test('both locales translate the new strategies', () => {
  for (const locale of ['zh-CN', 'en-US']) {
    const json = JSON.parse(read(`src/renderer/src/i18n/locales/${locale}.json`))
    for (const key of ['smart', 'pace', 'smartDesc', 'paceDesc']) {
      assert.ok(json.proxy?.[key], `${locale} is missing proxy.${key}`)
    }
  }
})
