/**
 * 开机自启的平台判定。
 *
 * 这里的每一条断言都对应一个"开关看起来开了、实际从来不自启"的真实成因 ——
 * 那类缺陷的共同点是**没有任何报错**，只能靠单测钉住。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyAutoStart,
  AUTOSTART_DESKTOP_FILE,
  AUTOSTART_HIDDEN_FLAG,
  buildLinuxDesktopEntry,
  quoteDesktopExecArg,
  resolveLaunchCommand,
  shouldLaunchHidden,
  type AutoStartPort,
  type LoginItemSettings,
} from '../../src/main/autostart.ts'

function createPort(overrides: Partial<AutoStartPort> = {}): {
  port: AutoStartPort
  loginItems: LoginItemSettings[]
  linuxWrites: Array<string | null>
} {
  const loginItems: LoginItemSettings[] = []
  const linuxWrites: Array<string | null> = []
  const port: AutoStartPort = {
    platform: 'win32',
    launchCommand: () => ({ path: 'C:\\App\\ModelPort.exe', args: [AUTOSTART_HIDDEN_FLAG] }),
    setLoginItem: (settings) => { loginItems.push(settings) },
    writeLinuxAutostart: async (content) => { linuxWrites.push(content) },
    linuxEntryName: 'ModelPort',
    linuxEntryComment: 'ModelPort 模型港（开机自启）',
    ...overrides,
  }
  return { port, loginItems, linuxWrites }
}

test('Windows portable 版必须注册真实 exe，而不是临时解包目录', () => {
  // 这是"开关开着却从来不自启"的第一号成因：portable 的 execPath 指向一个
  // 重启后不复存在的临时目录，写进注册表也白写。
  const portable = resolveLaunchCommand({
    platform: 'win32',
    execPath: 'C:\\Users\\me\\AppData\\Local\\Temp\\1B2C3\\ModelPort.exe',
    portableExecutableFile: 'D:\\Apps\\ModelPort-portable.exe',
  })
  assert.equal(portable.path, 'D:\\Apps\\ModelPort-portable.exe')
  assert.deepEqual(portable.args, [AUTOSTART_HIDDEN_FLAG])

  const installed = resolveLaunchCommand({ platform: 'win32', execPath: 'C:\\Program Files\\ModelPort\\ModelPort.exe' })
  assert.equal(installed.path, 'C:\\Program Files\\ModelPort\\ModelPort.exe')
})

test('Linux AppImage 用 APPIMAGE 本体，而不是挂载点里的只读路径', () => {
  const appImage = resolveLaunchCommand({
    platform: 'linux',
    execPath: '/tmp/.mount_ModelPxxxx/usr/bin/modelport',
    appImage: '/home/me/ModelPort-1.4.1-x64.AppImage',
  })
  assert.equal(appImage.path, '/home/me/ModelPort-1.4.1-x64.AppImage')

  const deb = resolveLaunchCommand({ platform: 'linux', execPath: '/usr/bin/modelport' })
  assert.equal(deb.path, '/usr/bin/modelport')
})

test('空白的环境变量不会被当成真实路径', () => {
  // `process.env.PORTABLE_EXECUTABLE_FILE` 在非 portable 构建里是 undefined，
  // 但空串同样不能让判定误以为"有可用的真实路径"。
  const blank = resolveLaunchCommand({ platform: 'win32', execPath: 'C:\\App\\ModelPort.exe', portableExecutableFile: '   ' })
  assert.equal(blank.path, 'C:\\App\\ModelPort.exe')
})

test('开机自启不抢焦点：--hidden 参数只对 Win/Linux 生效，macOS 交给 openAsHidden', () => {
  const win = resolveLaunchCommand({ platform: 'win32', execPath: 'C:\\App\\ModelPort.exe' })
  assert.deepEqual(win.args, [AUTOSTART_HIDDEN_FLAG])

  const mac = resolveLaunchCommand({ platform: 'darwin', execPath: '/Applications/ModelPort.app/Contents/MacOS/ModelPort' })
  assert.deepEqual(mac.args, [])
})

test('隐藏启动判据：命令行带 --hidden 或 macOS 报告由登录项拉起', () => {
  assert.equal(shouldLaunchHidden({ argv: ['ModelPort.exe'] }), false)
  assert.equal(shouldLaunchHidden({ argv: ['ModelPort.exe', AUTOSTART_HIDDEN_FLAG] }), true)
  // macOS 13+ 会忽略 openAsHidden 的意图，wasOpenedAtLogin 才是可靠判据。
  assert.equal(shouldLaunchHidden({ argv: ['ModelPort'], wasOpenedAtLogin: true }), true)
  assert.equal(shouldLaunchHidden({ argv: ['ModelPort'], wasOpenedAtLogin: false }), false)
})

test('Desktop Entry 的 Exec 参数逐项加引号并转义', () => {
  assert.equal(quoteDesktopExecArg('/opt/My App/modelport'), '"/opt/My App/modelport"')
  // `$HOME` 不加引号会被 exec 当变量展开；引号内的 `"` 与 `\` 也必须转义。
  assert.equal(quoteDesktopExecArg('/opt/$HOME/a"b\\c'), '"/opt/\\$HOME/a\\"b\\\\c"')
})

test('Linux 桌面项带 Exec、Hidden=false 与 X-GNOME-Autostart-enabled', () => {
  const entry = buildLinuxDesktopEntry({
    command: { path: '/usr/bin/modelport', args: [AUTOSTART_HIDDEN_FLAG] },
    name: 'ModelPort',
    comment: 'ModelPort 模型港（开机自启）',
  })

  assert.ok(entry.startsWith('[Desktop Entry]\n'))
  assert.ok(entry.includes('Type=Application'))
  assert.ok(entry.includes('Name=ModelPort'))
  assert.ok(entry.includes('Comment=ModelPort 模型港（开机自启）'))
  // 两个参数各自成项，缺引号时带空格的路径会被 exec 拆开。
  assert.ok(entry.includes('Exec="/usr/bin/modelport" "--hidden"'))
  assert.ok(entry.includes('Terminal=false'))
  // 缺这一行时 GNOME 会把项当成被用户禁用，开机照样不启动。
  assert.ok(entry.includes('X-GNOME-Autostart-enabled=true'))
  assert.ok(entry.includes('Hidden=false'))
})

test('Windows：开启写入 path+args，关闭清空 args 不留下带 --hidden 的残留', async () => {
  const on = createPort()
  await applyAutoStart(true, on.port)
  assert.deepEqual(on.loginItems, [{
    openAtLogin: true,
    path: 'C:\\App\\ModelPort.exe',
    args: [AUTOSTART_HIDDEN_FLAG],
  }])

  const off = createPort()
  await applyAutoStart(false, off.port)
  assert.deepEqual(off.loginItems, [{ openAtLogin: false, path: 'C:\\App\\ModelPort.exe', args: [] }])
})

test('macOS：开启带 openAsHidden，关闭时不传多余字段', async () => {
  const on = createPort({ platform: 'darwin', launchCommand: () => ({ path: '/Applications/ModelPort.app', args: [] }) })
  await applyAutoStart(true, on.port)
  assert.deepEqual(on.loginItems, [{ openAtLogin: true, openAsHidden: true }])

  const off = createPort({ platform: 'darwin' })
  await applyAutoStart(false, off.port)
  assert.deepEqual(off.loginItems, [{ openAtLogin: false }])
})

test('Linux：开启写桌面项，关闭删除（null 表示删除）', async () => {
  const on = createPort({ platform: 'linux', launchCommand: () => ({ path: '/usr/bin/modelport', args: [AUTOSTART_HIDDEN_FLAG] }) })
  await applyAutoStart(true, on.port)
  assert.equal(on.linuxWrites.length, 1)
  assert.ok(on.linuxWrites[0]?.includes('Exec="/usr/bin/modelport"'))

  const off = createPort({ platform: 'linux' })
  await applyAutoStart(false, off.port)
  assert.deepEqual(off.linuxWrites, [null], '关闭要给删除信号，而不是写一个空文件')
})

test('没有登录项机制的平台如实回答 unsupported，而不是假装成功', async () => {
  // 报 false 才有意义：调用方据此告警。假装 applied 会让开关永远静默失效。
  const port = createPort({ platform: 'freebsd' as NodeJS.Platform })
  const result = await applyAutoStart(true, port.port)
  assert.equal(result.applied, false)
  assert.equal(result.unsupported, true)
})

test('写失败必须上抛，不能吞掉（否则调用方无从记录原因）', async () => {
  const port = createPort({
    platform: 'linux',
    writeLinuxAutostart: async () => { throw new Error('EACCES: home is read-only') },
  })
  await assert.rejects(() => applyAutoStart(true, port.port), /EACCES/)
})

test('Linux 项文件名是固定常量（关掉时必须删同一个文件）', () => {
  assert.equal(AUTOSTART_DESKTOP_FILE, 'modelport.desktop')
})
