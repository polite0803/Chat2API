/**
 * 开机自启的平台判定（纯逻辑，**不 import electron**，因此可被 `node --test` 直接载入）。
 *
 * ## 为什么要单独一层
 *
 * `app.setLoginItemSettings` 只覆盖 macOS 与 Windows，而本应用同时发布 Linux
 * （AppImage / deb / tar.gz）。Linux 必须自己写 `~/.config/autostart/*.desktop`，
 * 否则开关"看起来开了"、实际开机什么都不发生。
 *
 * ## 三条会静默失效的路径（每条都配了单测）
 *
 * 1. **Windows portable 版**：真实 exe 在 `PORTABLE_EXECUTABLE_FILE`，
 *    而 `process.execPath` 指向临时解包目录 —— 写进注册表后下次开机那条路径
 *    已被删除，表现为"开关开着但从来不自启"，且没有任何报错。
 * 2. **Linux AppImage**：真实文件在 `APPIMAGE`，`process.execPath` 指向挂载点
 *    内的只读路径，同样开机即失效。
 * 3. **开机抢焦点**：代理是常驻服务，开机时把窗口糊到用户脸上是错的。
 *    Win/Linux 用 `--hidden` 参数，macOS 用 `openAsHidden` + `wasOpenedAtLogin`。
 */

/** 开机自启启动时的隐藏参数；`detectHiddenLaunch` 据此决定是否显示窗口。 */
export const AUTOSTART_HIDDEN_FLAG = '--hidden'

/** Linux 开机项文件名（`~/.config/autostart/<这个>`）。 */
export const AUTOSTART_DESKTOP_FILE = 'modelport.desktop'

/** 一条"开机要执行的命令"：可执行文件 + 附加参数。 */
export interface AutoStartLaunchCommand {
  path: string
  args: readonly string[]
}

export interface LaunchCommandInput {
  platform: NodeJS.Platform
  /** `process.execPath`。 */
  execPath: string
  /** electron-builder portable 解包后指向真实 exe（仅 Windows 有值）。 */
  portableExecutableFile?: string
  /** AppImage 运行时指向 `.AppImage` 文件本体（仅 Linux 有值）。 */
  appImage?: string
}

/**
 * 解析"开机时应该执行哪个文件"。
 *
 * Windows / Linux 都会把 `--hidden` 带上，故开机启动不弹窗；macOS 交给
 * `openAsHidden`，命令本身不带参数。
 */
export function resolveLaunchCommand(input: LaunchCommandInput): AutoStartLaunchCommand {
  const hiddenArgs: readonly string[] = [AUTOSTART_HIDDEN_FLAG]

  if (input.platform === 'win32') {
    const portable = input.portableExecutableFile?.trim() ?? ''
    // portable 版必须用真实 exe：`execPath` 是临时解包目录，重启机器后不复存在。
    return { path: portable.length > 0 ? portable : input.execPath, args: hiddenArgs }
  }

  if (input.platform === 'linux') {
    const appImage = input.appImage?.trim() ?? ''
    // 同理：AppImage 的 `execPath` 在挂载点内，必须换成文件本体。
    return { path: appImage.length > 0 ? appImage : input.execPath, args: hiddenArgs }
  }

  return { path: input.execPath, args: [] }
}

/**
 * 按 Desktop Entry 规范给 `Exec` 里的单个参数加引号。
 *
 * 路径带空格（`/opt/My App/`）不加引号会被 exec 拆成两个参数；双引号内还需
 * 转义 `\` `"` `` ` `` `$`，否则 `$HOME` 会被当成变量展开。
 */
export function quoteDesktopExecArg(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
  return `"${escaped}"`
}

export interface LinuxDesktopEntryInput {
  command: AutoStartLaunchCommand
  /** 桌面环境里显示的名字。 */
  name: string
  /** `Comment=`，仅展示用。 */
  comment?: string
}

/** 生成 XDG autostart 桌面项。写成纯函数是为了让内容可断言（见单测）。 */
export function buildLinuxDesktopEntry(input: LinuxDesktopEntryInput): string {
  const exec = [input.command.path, ...input.command.args]
    .map(quoteDesktopExecArg)
    .join(' ')
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${input.name}`,
    ...(input.comment === undefined ? [] : [`Comment=${input.comment}`]),
    `Exec=${exec}`,
    'Terminal=false',
    'Hidden=false',
    'X-GNOME-Autostart-enabled=true',
  ]
  return `${lines.join('\n')}\n`
}

export interface HiddenLaunchInput {
  /** `process.argv`。 */
  argv: readonly string[]
  /** macOS：`app.getLoginItemSettings().wasOpenedAtLogin`。 */
  wasOpenedAtLogin?: boolean
}

/** 这次启动是否应当保持隐藏（开机自启的常态）。 */
export function shouldLaunchHidden(input: HiddenLaunchInput): boolean {
  if (input.wasOpenedAtLogin === true) return true
  return input.argv.includes(AUTOSTART_HIDDEN_FLAG)
}

/** `app.setLoginItemSettings` 的入参（只声明用到的字段，便于测试注入）。 */
export interface LoginItemSettings {
  openAtLogin: boolean
  /** macOS：登录时隐藏启动（macOS 13+ 由系统忽略，仍传以保持意图）。 */
  openAsHidden?: boolean
  /** Windows：要注册的可执行文件。 */
  path?: string
  /** Windows：附在可执行文件后面的参数。 */
  args?: string[]
}

/**
 * 平台副作用的最小端口。生产实现见 `autostartHost.ts`；
 * 单测注入替身即可覆盖三分支，无需跑 Electron。
 */
export interface AutoStartPort {
  platform: NodeJS.Platform
  launchCommand: () => AutoStartLaunchCommand
  setLoginItem: (settings: LoginItemSettings) => void
  /** `content === null` 表示删除开机项；文件本就不存在时应直接返回。 */
  writeLinuxAutostart: (content: string | null) => Promise<void>
  linuxEntryName: string
  linuxEntryComment?: string
}

export interface AutoStartApplyResult {
  /** OS 状态是否已按请求写入。 */
  applied: boolean
  /** 当前平台没有可用的开机自启机制（如 *BSD）。 */
  unsupported?: boolean
}

/**
 * 把"是否开机自启"写进操作系统。
 *
 * 刻意**不 catch**：调用方（`syncAutoStartFromConfig`）要能记录"哪个平台、
 * 什么原因写失败"，静默吞掉正是"开关开着却从不自启"最难排查的成因。
 */
export async function applyAutoStart(
  enabled: boolean,
  port: AutoStartPort,
): Promise<AutoStartApplyResult> {
  if (port.platform === 'win32') {
    const command = port.launchCommand()
    port.setLoginItem({
      openAtLogin: enabled,
      path: command.path,
      // 关闭时清空参数：否则注册表里会留着一条带 `--hidden` 的残留配置。
      args: enabled ? [...command.args] : [],
    })
    return { applied: true }
  }

  if (port.platform === 'darwin') {
    port.setLoginItem(enabled
      ? { openAtLogin: true, openAsHidden: true }
      : { openAtLogin: false })
    return { applied: true }
  }

  if (port.platform === 'linux') {
    const content = enabled
      ? buildLinuxDesktopEntry({
          command: port.launchCommand(),
          name: port.linuxEntryName,
          comment: port.linuxEntryComment,
        })
      : null
    await port.writeLinuxAutostart(content)
    return { applied: true }
  }

  return { applied: false, unsupported: true }
}
