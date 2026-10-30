#!/usr/bin/env node
/**
 * 门禁前置自检：确认当前 `node` 能原生执行本仓库的 TypeScript 测试。
 *
 *     node scripts/check-node-version.mjs
 *
 * 为什么需要它：
 * 本仓库的测试是 `.ts` 文件（`tests` 目录下的 `*.test.ts`），只有 Node 原生支持
 * "type stripping" 之后才能用 `node --test` 直接跑。Node 22.12 及更早的
 * 22.x 版本没有默认开启，表现为整片 `ERR_UNKNOWN_FILE_EXTENSION`，看起来像
 * "全挂"，其实只是运行时不对。
 *
 * 注意只比版本号是不够的：
 *   - 22.6.0 引入了 type stripping，但当时在 `--experimental-strip-types` 后面，默认没开；
 *   - 22.18 / 23.6 起才默认开启。
 * 所以这里同时检查 `process.features.typescript` 这个能力位。
 *
 * 退出码：0 = 可以继续跑门禁；1 = 当前 node 不行，会打印可读的修复提示。
 */

const REQUIRED_MAJOR = 22
const REQUIRED_MINOR = 6
const REQUIRED_PATCH = 0

// 本机已验证可用的 Node 24 安装位置（PATH 上的 node 可能被别的工具遮蔽）。
const KNOWN_NODE_24_PATHS = [
  'C:\\Users\\polit\\AppData\\Local\\nodejs-24.14.0\\node-v24.14.0-win-x64\\node.exe',
  'C:\\Program Files\\nodejs\\node.exe',
]

function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function versionAtLeast(version, major, minor, patch) {
  if (!version) return false
  if (version.major !== major) return version.major > major
  if (version.minor !== minor) return version.minor > minor
  return version.patch >= patch
}

function describeCapability() {
  const feature = process.features.typescript
  if (feature === true) return '已开启（process.features.typescript === true）'
  if (typeof feature === 'string') return `已开启（process.features.typescript === ${JSON.stringify(feature)}）`
  return '未开启（process.features.typescript 为 falsy）'
}

function main() {
  const version = parseVersion(process.version)
  const versionOk = versionAtLeast(version, REQUIRED_MAJOR, REQUIRED_MINOR, REQUIRED_PATCH)
  const typeStrippingOk = Boolean(process.features.typescript)

  if (versionOk && typeStrippingOk) {
    console.log(`Node 运行时检查通过：${process.version}（${process.execPath}）`)
    console.log(`  原生 TypeScript 执行能力：${describeCapability()}`)
    return 0
  }

  console.error('')
  console.error('============================================================')
  console.error(' 门禁无法继续：当前 node 不能原生执行本仓库的 TypeScript 测试')
  console.error('============================================================')
  console.error('')
  console.error(`当前 node 版本 : ${process.version}`)
  console.error(`当前 node 路径 : ${process.execPath}`)
  console.error(`原生 TS 执行能力: ${describeCapability()}`)
  console.error('')

  if (!versionOk) {
    console.error(`原因 1：版本过低。需要 Node >= ${REQUIRED_MAJOR}.${REQUIRED_MINOR}.${REQUIRED_PATCH}。`)
  }
  if (!typeStrippingOk) {
    console.error('原因 2：本仓库的测试是 .ts 文件（tests/**/*.test.ts），必须由 Node 原生')
    console.error('        做 type stripping 才能用 `node --test` 直接执行。Node 22.6 引入该')
    console.error('        能力时还需要 --experimental-strip-types，直到 22.18 / 23.6 才默认开启。')
    console.error('        如果你直接运行 node --test 看到 ERR_UNKNOWN_FILE_EXTENSION，')
    console.error('        根因就是这里，而不是测试本身坏了。')
  }

  console.error('')
  console.error('修复方式（任选其一）：')
  console.error('  1) 把 Node 24 放到 PATH 最前面，例如 PowerShell：')
  console.error('       $env:Path = "C:\\Users\\polit\\AppData\\Local\\nodejs-24.14.0\\node-v24.14.0-win-x64;" + $env:Path')
  console.error('     之后 `node -v` 应当显示 v24.x，再跑 npm run gate。')
  console.error('  2) 直接用绝对路径调用：')
  for (const candidate of KNOWN_NODE_24_PATHS) {
    console.error(`       & "${candidate}" --test "tests/**/*.test.ts" "tests/**/*.test.mjs" "tests/**/*.test.js"`)
  }
  console.error('')
  console.error('注意：本机 PATH 上的 node 可能被其他工具遮蔽（当前机器上就是被 MarvisHost')
  console.error('目录里的 v22.12.0 遮住了），所以 `node -v` 显示的和 npm 脚本里实际用到的')
  console.error('可能不是同一个 —— 请以上面打印的 execPath 为准。')
  console.error('')

  return 1
}

process.exitCode = main()
