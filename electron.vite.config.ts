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
          'electron-store',
          'electron-updater'
        ]
      })
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
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
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    plugins: [react(), contentSecurityPolicy()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
      }
    },
    server: {
      host: '0.0.0.0',
      port: 5173
    }
  }
})
