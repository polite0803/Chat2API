/**
 * 定位本机的 OpenCode 运行时可执行文件。
 *
 * 优先用用户自己装好的那一个，找不到再退回 `npx opencode-ai@<pinned>`（Ferry 也是这么兜底的）。
 * 本模块只做"找"，不做下载：不替用户往磁盘里装东西。
 */
import { existsSync } from 'node:fs'
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
