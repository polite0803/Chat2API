/**
 * 测试用的 `electron` 替身模块（**仅** tests/ 使用，不进任何生产构建）。
 *
 * 为什么要它：`src/main/store/store.ts` 与它的全部传递依赖都 `import { app, safeStorage, … } from 'electron'`，
 * 而 `node --test` 跑的 `electron` 包只导出一个二进制路径字符串（`does not provide an export named 'app'`），
 * 真 Electron 在这个沙箱里（UNC 工作区 + 无显示环境）起不来。
 * 本模块让**真实实现**（store.ts、routes/*.ts、autoRouter.ts）原样跑起来，它只替掉 OS 边界：
 * - `app.getPath()` 一律指向调用方注入的临时目录（绝不碰开发者机器上的 `~/.modelport`）；
 * - `safeStorage.isEncryptionAvailable()` 返回 false —— 这是产品里有 documented 的分支
 *   （`planKeySetup` 的 `unencrypted`：无 key、明文 data.json），不是替身编出来的行为；
 * - `BrowserWindow.getAllWindows()` 返回空表：`sendRequestLog` / 广播因此静默丢弃，
 *   IPC 边界不参与本用例要证明的东西。
 *
 * ⚠️ 这里没有任何路由/配置语义：所有断言走的都是 src/ 里的真代码。
 */

const NOOP = () => undefined

/** 由 harness 在 `initialize()` 之前写入；生产代码只通过 `app.getPath()` 读它。 */
export const stubState = {
  userDataDir: process.env.MODELPORT_TEST_DATADIR || process.cwd(),
}

export const app = {
  getName: () => 'modelport-test',
  getAppPath: () => stubState.userDataDir,
  getPath: (name) => {
    if (name === 'userData' || name === 'appData' || name === 'logs') return stubState.userDataDir
    if (name === 'temp') return stubState.userDataDir
    return stubState.userDataDir
  },
  setPath: NOOP,
  getVersion: () => '0.0.0-test',
  isReady: () => true,
  whenReady: () => Promise.resolve(),
  on: NOOP,
  once: NOOP,
  quit: NOOP,
  setLoginItemSettings: NOOP,
  getLoginItemSettings: () => ({}),
  isPackaged: false,
  commandLine: { appendSwitch: NOOP, getSwitchValue: () => '' },
}

export const safeStorage = {
  // 明确「OS 钥匙串不可用」：store.ts 走 planKeySetup 的 unencrypted 分支，
  // 与 Linux 无 keystore 的安装同形，data.json 保持明文可读。
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.from(''),
  decryptString: () => '',
}

export class BrowserWindow {
  static getAllWindows() {
    return []
  }

  isDestroyed() {
    return true
  }

  webContents = { send: NOOP, isDestroyed: () => true }
}

export const ipcMain = { on: NOOP, handle: NOOP, removeHandler: NOOP, removeAllListeners: NOOP }
export const ipcRenderer = { send: NOOP, invoke: () => Promise.resolve(undefined), on: NOOP }
export const shell = { openExternal: () => Promise.resolve(), showItemInFolder: NOOP, openPath: () => Promise.resolve('') }
export const dialog = {
  showMessageBox: () => Promise.resolve({ response: 0 }),
  showMessageBoxSync: () => 0,
  showErrorBox: NOOP,
}
export const Menu = { buildFromTemplate: () => ({ items: [] }), setApplicationMenu: NOOP, getApplicationMenu: () => null }
export class Tray {
  setToolTip() {}
  setContextMenu() {}
  destroy() {}
}
export const nativeImage = { createFromPath: () => ({ isEmpty: () => true, toPNG: () => Buffer.from('') }) }
export const nativeTheme = { shouldUseDarkColors: false, on: NOOP }
export const screen = {
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
  getAllDisplays: () => [],
}
export const powerMonitor = { on: NOOP }
export class Notification {
  static isSupported() {
    return false
  }

  show() {}
}

export default { app, safeStorage, BrowserWindow, ipcMain, shell, dialog, Menu, nativeImage, nativeTheme, screen }
