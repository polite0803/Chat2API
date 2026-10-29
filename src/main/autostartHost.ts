/**
 * 开机自启的 Electron 适配层：把 `autostart.ts` 的纯逻辑接到真实操作系统。
 *
 * 所有需要 `electron` 的部分都集中在这里，使纯逻辑模块（`autostart.ts`）能被
 * 现有的 `node --test` 直接载入 —— 本项目的测试不 mock electron，一旦纯逻辑
 * 也 import 它，就再也无法在没有 Electron 运行时的环境里断言。
 */

import { app } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  applyAutoStart,
  AUTOSTART_DESKTOP_FILE,
  resolveLaunchCommand,
  shouldLaunchHidden,
  type AutoStartPort,
  type LoginItemSettings,
} from './autostart'

/** Linux 开机项的落盘路径（XDG 规范位置）。 */
export function linuxAutostartPath(): string {
  return join(homedir(), '.config', 'autostart', AUTOSTART_DESKTOP_FILE)
}

function launchCommand(): ReturnType<typeof resolveLaunchCommand> {
  return resolveLaunchCommand({
    platform: process.platform,
    execPath: process.execPath,
    portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE,
    appImage: process.env.APPIMAGE,
  })
}

async function writeLinuxAutostart(content: string | null): Promise<void> {
  const path = linuxAutostartPath()
  if (content === null) {
    // 项不存在时 `rm` 会 ENOENT；`force: true` 让"本来就没有"也算成功 ——
    // 关掉一个从未成功写入的开关不该报错。
    await rm(path, { force: true })
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, { encoding: 'utf8', mode: 0o644 })
}

const port: AutoStartPort = {
  platform: process.platform,
  launchCommand,
  setLoginItem: (settings: LoginItemSettings) => app.setLoginItemSettings(settings),
  writeLinuxAutostart,
  linuxEntryName: 'ModelPort',
  linuxEntryComment: 'ModelPort 模型港（开机自启）',
}

/** 把"是否开机自启"写进操作系统。 */
export interface AutoStartSyncResult {
  /** OS 状态已按请求写入。 */
  applied: boolean
  /**
   * 为什么没写。`unpackaged` = 开发态（不能注册裸 Electron）；
   * `unsupported` = 当前平台没有登录项机制。
   */
  skipped?: 'unpackaged' | 'unsupported'
}

/**
 * 把"是否开机自启"写进操作系统。
 *
 * ## 为什么开发态拒绝落盘
 *
 * 开发态 `process.execPath` 指向 Electron 本体（`node_modules/electron/dist/…`），
 * 把它注册成登录项，开机拉起的是一个**没有应用包、没有入口 main 的裸 Electron**
 * ——用户看到的是一个空白进程，而 macOS 上连有效应用包都不存在。开关的**意图**
 * 仍然写进 `data.json`（由调用方负责），只是不落 OS。
 *
 * 代价是「开发态验证不了」：要确认真的会开机自启，需要打包产物，或者看
 * `tests/main/autostart.test.ts` 覆盖的平台判定。
 */
export async function syncAutoStart(enabled: boolean): Promise<AutoStartSyncResult> {
  if (!app.isPackaged) {
    console.log(
      '[AutoStart] 开发态不注册登录项（会拉起裸 Electron）；开关意图已记入配置，'
      + '打包后生效',
    )
    return { applied: false, skipped: 'unpackaged' }
  }
  const result = await applyAutoStart(enabled, port)
  return result.unsupported === true
    ? { applied: false, skipped: 'unsupported' }
    : { applied: true }
}

/**
 * 读取操作系统侧的真实状态。
 *
 * ⚠️ Linux **不能**用 `app.getLoginItemSettings()`（Electron 的登录项 API 只覆盖
 * macOS 与 Windows），必须查那个 `.desktop` 文件本身，否则 Linux 上永远是
 * "配置说开了、系统里没有"却无人修正。
 */
export function readOsAutoStartEnabled(): boolean | undefined {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return app.getLoginItemSettings().openAtLogin === true
  }
  if (process.platform === 'linux') return existsSync(linuxAutostartPath())
  return undefined
}

/**
 * 这次启动是否由「开机自启」触发。
 *
 * **刻意不读 `data.json`**：判定只需要 `argv`（Win/Linux 我们自己带了
 * `--hidden`）与 macOS 的 `wasOpenedAtLogin`。让它依赖配置会引入一个多余的
 * 前置条件 —— 配置要等 store 初始化后才能读，而窗口是否显示必须在建窗时就定下。
 *
 * ⚠️ macOS 13+ 会忽略登录项的「隐藏打开」意图，故 `wasOpenedAtLogin` 是更可靠的
 * 判据；两者都用，任一条命中即隐藏。
 */
export function detectHiddenLaunch(): boolean {
  return shouldLaunchHidden({
    argv: process.argv,
    wasOpenedAtLogin: process.platform === 'darwin'
      ? app.getLoginItemSettings().wasOpenedAtLogin === true
      : undefined,
  })
}

/**
 * 启动后把**配置**对账进操作系统。
 *
 * ## 为什么要对账，而不是"只在用户点开关时写"
 *
 * 只靠点击写入，会让两种分叉永远无人修正：
 * - 重装/换机后注册表项或 `.desktop` 丢失，而 `data.json` 里仍是 `true`；
 * - 从旧版本升级上来，配置里早就有 `true`，但旧版本从未写过 OS（本次修复前的
 *   真实状态），于是用户眼里就是"我明明开了，它却不开机"。
 *
 * ## 为什么写失败只告警
 *
 * 企业策略禁用登录项、Linux 家目录只读、注册表被锁，都不该挡住应用启动。
 * 但**必须留下日志** —— 静默吞掉的后果正是本修复要消灭的那个症状。
 *
 * 调用时机：**store 初始化之后**（本函数要读配置）。`setupApp` 里它排在
 * `registerIpcHandlers` 之后，正是这个原因。
 */
export async function reconcileAutoStart(desired: boolean): Promise<void> {
  // 开发态不参与对账：`syncAutoStart` 本就不落 OS，继续比对只会每轮都判定
  // "不一致"并打出一条误导性的校正失败日志。
  if (!app.isPackaged) return

  const osEnabled = readOsAutoStartEnabled()

  if (osEnabled === undefined) {
    console.warn(`[AutoStart] ${process.platform} 没有可用的开机自启机制，开关不会生效`)
    return
  }

  if (osEnabled === desired) return

  try {
    await syncAutoStart(desired)
    console.log(`[AutoStart] 已按配置校正开机自启：${desired ? '开启' : '关闭'}`)
  } catch (error) {
    console.warn(
      `[AutoStart] 开机自启状态校正失败（不影响使用，配置值仍为 `
      + `${desired ? 'true' : 'false'}）：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
