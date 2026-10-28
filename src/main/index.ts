import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { createWindow, getMainWindow, loadUrl, loadFile, openDevTools } from './window/manager'
import { createTrayManager, TrayManager } from './tray/TrayManager'
import { registerIpcHandlers } from './ipc/handlers'
import { UpdaterManager } from './updater'
import { storeManager } from './store/store'
import { opencodeService } from './opencode/service'

// Keep the Electron profile directory stable across product renames.
// safeStorage seals store.key and every stored credential against this profile
// (Windows keeps the wrapped key in `Local State`, macOS in the login keychain
// entry tied to it), so deriving it from package.json's `name` would make an
// existing install unreadable the moment the package is renamed.
app.setPath('userData', join(app.getPath('appData'), 'chat2api'))

// Prevent uncaught exceptions from crashing the app
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason)
})

// Workaround for V8 JIT compiler crash on macOS ARM64 (Electron 33 bug)
// Completely disable JIT compilation to prevent EXC_BAD_ACCESS crashes
// This trades some performance for stability
if (process.platform === 'darwin' && process.arch === 'arm64') {
  app.commandLine.appendSwitch('js-flags', '--jitless --no-opt')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}

// Automatically add --no-sandbox flag when running as root user
if (process.getuid && process.getuid() === 0) {
  console.log('Detected running as root user, sandbox settings have been automatically handled')
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const mainWindow = getMainWindow()
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.show()
      mainWindow.focus()
    }
  })

  initializeApp()
}

let trayManager: TrayManager | null = null

async function initializeApp(): Promise<void> {
  app.on('ready', async () => {
    await setupApp()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('activate', () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) {
      createWindow()
    } else {
      mainWindow.show()
    }
  })

  app.on('before-quit', () => {
    app.isQuitting = true
    trayManager?.destroy()
  })

  app.on('will-quit', () => {
    opencodeService.stop()
    cleanup()
  })
}

async function setupApp(): Promise<void> {
  const mainWindow = createWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'ModelPort',
    show: false,
  })

  await registerIpcHandlers(mainWindow)

  trayManager = createTrayManager(mainWindow)

  await loadAppContent(mainWindow)

  // 渲染层在挂载前无法收到 STORE_INIT_ERROR（那时 webContents 还没加载），
  // 所以存储不可用时必须用原生对话框把原因和处置办法直接摆到用户面前。
  if (storeManager.hasInitializationError()) {
    await showStorageFailureDialog(mainWindow)
  }

  if (process.env.NODE_ENV === 'development') {
    openDevTools()
  }
}

async function showStorageFailureDialog(mainWindow: BrowserWindow | null): Promise<void> {
  const dataDir = join(homedir(), '.chat2api')
  const reason = storeManager.getInitializationError()?.message ?? 'unknown error'
  const options = {
    type: 'error' as const,
    title: '本地数据无法读取',
    message: '应用数据初始化失败，配置与账号暂不可用',
    detail: [
      reason,
      '',
      `数据目录：${dataDir}`,
      'store.key 解密失败通常意味着系统凭据/账户密码被重置。',
      '处理办法：先备份，再把 store.key 与 data.json 移到别处后重启应用；',
      '如需恢复旧数据，可用同目录的 data.json.pre-key-migration.bak 覆盖 data.json。',
    ].join('\n'),
    buttons: ['打开数据目录', '退出'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }

  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)

  if (response === 0) {
    await shell.openPath(dataDir)
    return
  }

  app.isQuitting = true
  app.quit()
}

async function loadAppContent(mainWindow: BrowserWindow): Promise<void> {
  const isDev = process.env.NODE_ENV === 'development'

  if (isDev) {
    try {
      await loadUrl(process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173')
    } catch (error) {
      console.error('Failed to load development server:', error)
    }
  } else {
    try {
      await loadFile(join(__dirname, '../renderer/index.html'))
    } catch (error) {
      console.error('Failed to load production files:', error)
    }
  }
}

function cleanup(): void {
  console.log('Application is exiting, performing cleanup...')
  storeManager.flushPendingWrites()
  const updaterManager = UpdaterManager.getInstance()
  updaterManager.destroy()
}

export function restartApp(): void {
  app.relaunch()
  app.quit()
}

export function getAppVersion(): string {
  return app.getVersion()
}

export function isAppQuitting(): boolean {
  return app.isQuitting ?? false
}

export { getMainWindow }
