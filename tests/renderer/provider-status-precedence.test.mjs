import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test('卡片上的状态取现场检查结果，不取落库的旧快照', () => {
  const cardSource = readFileSync(
    join(root, 'src/renderer/src/components/providers/ProviderCard.tsx'),
    'utf8',
  )
  const pageSource = readFileSync(join(root, 'src/renderer/src/pages/Providers.tsx'), 'utf8')

  // provider.status 是上次检查落库的快照；不先看现场结果的话，
  // 第一次记下来的值会把后来的新结果一直盖住（状态永远停在"未知"）
  assert.match(cardSource, /const currentStatus = status \|\| provider\.status \|\| 'unknown'/)
  assert.doesNotMatch(cardSource, /const currentStatus = provider\.status \|\|/)

  // 检查完要把供应商记录里那份快照一起刷新（单个检查与批量刷新两处都要）
  const refreshCalls = pageSource.match(/store\.updateProvider\(id, \{ status: result\.status \}\)/g) || []
  assert.equal(refreshCalls.length, 2)
})

test('运行时进程自己退出时，服务状态跟着退出', () => {
  const bridgeSource = readFileSync(join(root, 'src/main/opencode/bridge.ts'), 'utf8')
  const serviceSource = readFileSync(join(root, 'src/main/opencode/service.ts'), 'utf8')

  assert.match(bridgeSource, /child\.on\('exit',[\s\S]*?this\.onExit\?\.\(\)/)
  assert.match(serviceSource, /new OpencodeBridge\([\s\S]*?running: false/)
})
