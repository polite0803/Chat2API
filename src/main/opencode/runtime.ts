/**
 * 定位本机的 OpenCode 运行时可执行文件。
 *
 * 优先用用户自己装好的那一个，找不到再退回 `npx opencode-ai@<pinned>`（Ferry 也是这么兜底的）。
 * 本模块只做"找"，不做下载：不替用户往磁盘里装东西。
 */
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface OpencodeLauncher {
  command: string
  args: string[]
  /** 说明这个启动器是怎么来的，用于界面与日志 */
  source: string
}

/** 与 package.json 里的 pin 保持一致；升级时只改这一处 */
export const OPENCODE_PACKAGE = 'opencode-ai@1.19.4'

function firstExisting(candidates: Array<{ path: string; source: string }>): OpencodeLauncher | null {
  for (const candidate of candidates) {
    if (candidate.path && existsSync(candidate.path)) {
      return { command: candidate.path, args: [], source: candidate.source }
    }
  }
  return null
}

function fromPath(): OpencodeLauncher | null {
  const pathValue = process.env.PATH ?? ''
  const separator = process.platform === 'win32' ? ';' : ':'
  const names = process.platform === 'win32' ? ['opencode.exe', 'opencode.cmd'] : ['opencode']
  for (const dir of pathValue.split(separator)) {
    if (!dir) continue
    for (const name of names) {
      const full = join(dir, name)
      if (existsSync(full)) return { command: full, args: [], source: 'PATH' }
    }
  }
  return null
}

export function resolveOpencodeLauncher(env: NodeJS.ProcessEnv = process.env): OpencodeLauncher {
  const explicit = env.OPENCODE_BIN?.trim()
  if (explicit && existsSync(explicit)) {
    return { command: explicit, args: [], source: 'OPENCODE_BIN' }
  }

  const home = homedir()
  const installed = firstExisting([
    {
      path: join(home, '.opencode', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
      source: '~/.opencode/bin',
    },
    {
      path: join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm', 'opencode.cmd'),
      source: 'npm global',
    },
    { path: '/opt/homebrew/bin/opencode', source: 'homebrew' },
    { path: '/usr/local/bin/opencode', source: 'usr/local' },
  ])
  if (installed) return installed

  const onPath = fromPath()
  if (onPath) return onPath

  return { command: 'npx', args: ['-y', OPENCODE_PACKAGE], source: 'npx fallback' }
}

export interface CatalogRefreshResult {
  ok: boolean
  detail: string
}

/**
 * 跑一次 `models opencode --refresh`，把运行时自带的模型目录刷到最新。
 *
 * 为什么需要：`/provider` 给的是运行时**包里**的目录快照，可能落后于上游；
 * ow-lite 也是先刷新再取目录。只能在运行时**没起来**的时候跑——两个进程共用
 * 同一个数据目录（SQLite），并发写会互相锁住。失败一律忽略，不影响主流程。
 */
export async function refreshModelCatalog(
  launcher: OpencodeLauncher,
  options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs?: number },
): Promise<CatalogRefreshResult> {
  const timeoutMs = options.timeoutMs ?? 90_000

  return new Promise<CatalogRefreshResult>(resolve => {
    let output = ''
    let settled = false
    const finish = (result: CatalogRefreshResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    let child
    try {
      child = spawn(
        launcher.command,
        [...launcher.args, 'models', 'opencode', '--refresh', '--pure'],
        {
          cwd: options.cwd,
          env: options.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          // npx.cmd 在 Windows 上必须经 shell 启动
          shell: process.platform === 'win32',
        },
      )
    } catch (error) {
      resolve({ ok: false, detail: error instanceof Error ? error.message : String(error) })
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 已经退出
      }
      finish({ ok: false, detail: `timed out after ${timeoutMs}ms` })
    }, timeoutMs)

    const collect = (chunk: unknown) => {
      output = (output + String(chunk)).slice(-2000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', error => finish({ ok: false, detail: error.message }))
    child.on('exit', code => finish({ ok: code === 0, detail: `exit ${code}: ${output.slice(-300)}` }))
  })
}
