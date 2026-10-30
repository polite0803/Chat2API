import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// Production loads the renderer from file://, so the policy goes into the HTML
// itself - webRequest.onHeadersReceived never sees file:// requests. 'self' is
// the document's own origin; style-src still needs 'unsafe-inline' because
// Radix sets style attributes, and the renderer talks to the main process over
// IPC only, never over the network.
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'"
].join('; ')

// The dev server serves the page from http://localhost:5173 and @vitejs/plugin-react
// injects an inline refresh preamble, so both inline script and the HMR socket
// have to be allowed. Everything else stays as strict as production.
const DEVELOPMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'"
].join('; ')

function contentSecurityPolicy(): Plugin {
  let dev = false
  return {
    name: 'modelport-csp',
    configResolved(config) {
      dev = config.command === 'serve'
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: dev ? DEVELOPMENT_CSP : PRODUCTION_CSP
          },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

export default defineConfig({
  // ⚠️ 不要用 __dirname：electron-vite 加载 config 前会 realpathSync(configFile)，
  // 在 VMware 共享文件夹的映射盘环境（D: → \\vmware-host\Shared Folders\D）下会得到
  // UNC 形态路径，随后 vite 的 realpath/URL 转换会产出 `Z:\ Folders\D\...` 这类坏路径。
  // 构建进程的 cwd 始终是 package.json 所在目录（盘符形态），以此为基准最稳。
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          'axios',
          '@koa/router',
          'koa',
          'koa-bodyparser',
          'koa-router',
          'eventsource-parser',
          'js-sha3',
          'mime-types',
          'zstd-codec',
          // ⚠️ electron-store 必须保持 external（不放进 exclude）：
          // 它是 ESM-only 包，CJS 产物 require 不了；而打包路径在本机的映射盘
          // 环境下会被 vite resolver 搞挂。store.ts 用的是 `await import(...)`
          // 动态导入，rollup 4 的 CJS 输出默认保留原生 `import()`，Electron
          // main 进程（Node ≥20）可以在运行时直接加载 ESM。
          'electron-updater'
        ]
      })
    ],
    resolve: {
      // 映射盘 realpath 会把模块 id 还原成 UNC，见顶部说明。
      preserveSymlinks: true
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(process.cwd(), 'src/main/index.ts')
        },
        output: {
          format: 'cjs'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(process.cwd(), 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(process.cwd(), 'src/renderer'),
    plugins: [react(), contentSecurityPolicy()],
    resolve: {
      // 映射盘 realpath 会把模块 id 还原成 UNC 坏路径，见顶部说明。
      preserveSymlinks: true,
      alias: {
        '@': resolve(process.cwd(), 'src/renderer/src'),
        '@shared': resolve(process.cwd(), 'src/shared'),
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(process.cwd(), 'src/renderer/index.html')
        }
      }
    },
    server: {
      host: '0.0.0.0',
      port: 5173
    }
  }
})
