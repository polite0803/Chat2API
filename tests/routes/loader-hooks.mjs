/**
 * `node --test` 下加载 `src/main/**` 所需的 ESM resolve 钩子。
 *
 * 只做三件事，且都不是「替身逻辑」——被测代码的语义一律来自 src/：
 * 1. 把裸模块名 `electron` 指到 `tests/routes/electron-stub.mjs`（真 Electron 在这个沙箱起不来，
 *    而 `node_modules/electron` 只导出二进制路径字符串，命名导入会直接 SyntaxError）；
 * 2. 补齐 src/ 里 bundler 风格的**无扩展名相对导入**（`from './types'`、`from '../ipc/channels'`）：
 *    vite/electron-vite 会补 `.ts` / `/index.ts`，Node 原生 ESM 不会；
 * 3. 用仓库自己的 `typescript@5.9.3` 逐文件转译 `.ts`（见 `load`）。
 *
 * 解析规则严格镜像 bundler 的做法，且不掩盖真实缺失：候选文件不存在就抛回原始错误。
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'

const STUB_URL = new URL('./electron-stub.mjs', import.meta.url).href

const CANDIDATE_SUFFIXES = ['.ts', '.tsx', '.mjs', '.js']
const INDEX_SUFFIXES = ['/index.ts', '/index.mjs', '/index.js']

/** 只在「显式带扩展名」或裸包名时放行原解析器。 */
function hasExtension(specifier) {
  const last = specifier.slice(specifier.lastIndexOf('/') + 1)
  return /\.[a-zA-Z]+$/.test(last)
}

function localCandidates(specifier, context) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
  if (!isRelative) return []
  if (context.parentURL === undefined) return []
  const baseDir = dirname(fileURLToPath(context.parentURL))
  const absolute = join(baseDir, specifier)
  const out = []
  for (const suffix of CANDIDATE_SUFFIXES) out.push(absolute + suffix)
  for (const suffix of INDEX_SUFFIXES) out.push(absolute + suffix)
  return out
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: STUB_URL, shortCircuit: true, format: 'module' }
  }

  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (!hasExtension(specifier)) {
      for (const candidate of localCandidates(specifier, context)) {
        if (existsSync(candidate)) {
          // ⚠️ 不写 `format`：交给 Node 按扩展名推断（`.ts` → `module-typescript`，
          // 才有原生类型剥离；硬写 `module` 会让 `import type` 变成语法错误）。
          return { url: pathToFileURL(candidate).href, shortCircuit: true }
        }
      }
    }
    throw error
  }
}

/**
 * 逐文件转译 `.ts`（`typescript@5.9.3`，与本仓 `tsc` 同一个编译器，**不 spawn 任何子进程**）。
 *
 * 为什么不用 Node 原生的类型剥离：`src/main/store/store.ts:11` 这样的写法把**类型和值放在同一条
 * `import { StoreSchema, AppConfig, …, DEFAULT_CONFIG } from './types'` 里**。原生剥离只删
 * `import type`，于是 `Account`、`Provider` 这些纯类型名会留在运行时导入里，链接阶段直接
 * `does not provide an export named 'Account'`（实测）。TS 的转译会按「值位置未引用」把类型名消掉，
 * 正是 bundler 走的那条路，所以这里换用它，而不是去改 src/。
 *
 * 只动 `.ts`；`.mjs`/`.js`（含 electron 替身、harness、node_modules）原样交给 Node。
 */
export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !url.endsWith('.ts')) {
    return nextLoad(url, context)
  }

  const filename = fileURLToPath(new URL(url))
  if (filename.endsWith('.d.ts')) {
    // 声明文件没有运行时内容：给一个空模块，而不是让 Node 去剥离 `export {}`
    return { format: 'module', source: 'export {}', shortCircuit: true }
  }

  const source = readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
      isolatedModules: false,
      inlineSourceMap: true,
      inlineSources: true,
    },
  })

  return { format: 'module', source: outputText, shortCircuit: true }
}
