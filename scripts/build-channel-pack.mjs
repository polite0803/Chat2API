#!/usr/bin/env node
/**
 * 把 vendor 的 channel-pack 源码打成单个 worker bundle。
 *
 *     node scripts/build-channel-pack.mjs
 *
 * 为什么打包而不是直接跑源码目录：worker 要作为 `extraResources` 里的独立文件
 * 加载（asar 内起 worker 会找不到模块），而源码是 149 个 TS 文件，无法随包分发。
 * 产物进 `resources/channel-pack/`，不入库；升级 vendor 只需重新执行本脚本。
 *
 * 外部依赖只有四个：`@deepseek-ai/*`（契约）与 `undici`（代理 dispatcher）。
 * 前者由 `src/main/channelPack/compat/` 提供，后者是真实 npm 依赖，打进 bundle。
 */
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const vendor = path.join(root, 'vendor', 'channel-pack')
const compat = path.join(root, 'src', 'main', 'channelPack', 'compat')
const outDir = path.join(root, 'resources', 'channel-pack')
const outfile = path.join(outDir, 'worker.mjs')
const entry = path.join(root, 'src', 'main', 'channelPack', 'worker.ts')

const esbuild = await import('esbuild')

await mkdir(outDir, { recursive: true })

const result = await esbuild.build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  alias: {
    'virtual:channel-pack': path.join(vendor, 'src', 'index.ts'),
    'virtual:channel-pack-messages': path.join(vendor, 'src', 'openai-gateway', 'messages.ts'),
    'virtual:channel-pack-gateway': path.join(vendor, 'src', 'openai-gateway', 'channel.ts'),
    'virtual:channel-pack-stream': path.join(vendor, 'src', 'openai-gateway', 'stream.ts'),
    'virtual:channel-pack-models': path.join(vendor, 'src', 'openai-gateway', 'models.ts'),
    '@deepseek-ai/dsh-llm': path.join(compat, 'dshLlm.ts'),
    '@deepseek-ai/dsh-credentials': path.join(compat, 'dshCredentials.ts'),
    '@deepseek-ai/cordis': path.join(compat, 'cordis.ts'),
    '@deepseek-ai/schemastery': path.join(compat, 'schemastery.ts'),
    '@deepseek-ai/dsh-agent': path.join(compat, 'dshAgent.ts'),
  },
  plugins: [{
    name: 'channel-pack-compat',
    setup(build) {
      // 只把 vendor 里的 `undici` 换成垫片；垫片自身仍解析到真实依赖，避免自引用循环。
      build.onResolve({ filter: /^undici$/ }, args => {
        if (!args.importer.startsWith(vendor + path.sep)) return undefined
        return { path: path.join(compat, 'undici.ts') }
      })
      // 上游从宿主仓库越界导入 `../../../src/image-pricing.js`（只提供了 d.ts）。
      // 上游源码原样保留，解析改指向本仓库的替身。
      build.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/src\/image-pricing\.js$/ }, args => {
        if (!args.importer.startsWith(vendor + path.sep)) return undefined
        return { path: path.join(compat, 'imagePricing.ts') }
      })
    },
  }],
  banner: {
    js: [
      '// 由 scripts/build-channel-pack.mjs 生成，请勿手改。',
      '// 来源：vendor/channel-pack/src（见同目录 NOTICE.md）。',
      // 打进 bundle 的 CJS 依赖（undici）会用 require() 取 node 内置模块，
      // ESM 产物里没有 require 时 esbuild 的 helper 会抛 "Dynamic require"。
      "import { createRequire as __channelPackCreateRequire } from 'node:module'",
      'const require = __channelPackCreateRequire(import.meta.url)',
    ].join('\n'),
  },
})

const bytes = (await stat(outfile)).size
if (!existsSync(outfile) || !(await readFile(outfile, 'utf8')).slice(0, 300).includes('scripts/build-channel-pack.mjs')) {
  console.error('build-channel-pack: 产物缺少 banner，拒绝视为成功')
  process.exit(1)
}

for (const file of ['qoder-auth-wasm.wasm', 'LICENSE', 'NOTICE.md']) {
  await copyFile(path.join(vendor, file), path.join(outDir, file))
}

console.log(`build-channel-pack: wrote resources/channel-pack/worker.mjs (${(bytes / 1024 / 1024).toFixed(2)} MiB)`)
if (result.warnings.length > 0) {
  console.log(`build-channel-pack: ${result.warnings.length} warning(s)`)
}
