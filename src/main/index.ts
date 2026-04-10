import { app, shell, BrowserWindow, ipcMain, powerMonitor, Notification } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log'
import icon from '../../resources/icon.png?asset'
import { DesktopEngine } from './engine'
import { initializeUpdater } from './updater'

// Initialize Tracking Engine early
const engine = new DesktopEngine()

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC handlers for Authentication & Tracking Control
  ipcMain.on('save-auth', (event, { url, token }) => {
    engine.setAuth(url, token)
  })

  ipcMain.on('logout', () => {
    engine.stopTracking()
    engine.setAuth('', '')
  })

  ipcMain.on('start-tracking', () => {
    engine.startTracking()
  })

  ipcMain.on('stop-tracking', () => {
    engine.stopTracking()
  })

  // Provide realtime idle time to the frontend dashboard 
  ipcMain.handle('get-idle-time', () => {
    return powerMonitor.getSystemIdleTime()
  })

  // Force the window to pop up and focus if the user becomes idle
  ipcMain.on('force-focus', () => {
    BrowserWindow.getAllWindows().forEach((win) => {
      // Deeper aggressive hooks to force unminimize in strict Linux environments (GNOME/Wayland)
      if (win.isMinimized()) win.restore()
      // Briefly set AlwaysOnTop to pierce through other windows
      win.setAlwaysOnTop(true, 'floating')
      win.show()
      // @ts-ignore
      if (app.focus) app.focus({ steal: true }) 
      win.focus()
      win.setAlwaysOnTop(false)
    })

    // Fail-safe: Trigger an OS Notification so if the Linux window manager STILL blocks it, they get pinged
    if (Notification.isSupported()) {
      const notify = new Notification({
        title: 'WorkPulse: Are you still working?',
        body: 'You have been idle. Please return or time tracking will be automatically paused.',
        urgency: 'critical'
      })
      notify.on('click', () => {
        BrowserWindow.getAllWindows().forEach((win) => {
          if (win.isMinimized()) win.restore()
          win.show()
          win.focus()
        })
      })
      notify.show()
    }
  })

  // Native Mini-Mode Window Resizing
  ipcMain.on('toggle-mini', (event, isMini) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return

    if (isMini) {
      win.setSize(480, 160)
      win.setAlwaysOnTop(true, 'floating')
      win.setResizable(false)
      win.center()
    } else {
      win.setSize(900, 670)
      win.setAlwaysOnTop(false)
      win.setResizable(true)
      win.center()
    }
  })

  // Handle 'Launch at Startup' toggle
  ipcMain.on('set-launch-at-startup', (_, openAtLogin: boolean) => {
    app.setLoginItemSettings({
      openAtLogin,
      path: app.getPath('exe')
    })
  })

  ipcMain.handle('get-launch-at-startup', () => {
    return app.getLoginItemSettings().openAtLogin
  })

  ipcMain.on('trigger-sync', () => {
    log.info('Manual sync triggered.')
    engine.syncOfflineQueue()
  })

  // Power State Awareness: Screen Lock/Unlock & Suspend/Resume
  powerMonitor.on('lock-screen', () => {
    log.info('System locked.')
    engine.setPowerState(true)
  })

  powerMonitor.on('unlock-screen', () => {
    log.info('System unlocked.')
    engine.setPowerState(false)
  })

  powerMonitor.on('suspend', () => {
    log.info('System suspending.')
    engine.setPowerState(true)
  })

  powerMonitor.on('resume', () => {
    log.info('System resumed.')
    engine.setPowerState(false)
  })

  createWindow()
  initializeUpdater()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Handle Second Instance
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  log.info('Another instance is already running. Quitting.')
  app.quit()
} else {
  app.on('second-instance', () => {
    const windows = BrowserWindow.getAllWindows()
    if (windows.length > 0) {
      const win = windows[0]
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  // Graceful shutdown — ensure we clock out if the user force quits the app
  app.on('before-quit', () => {
    log.info('Application quitting. Stopping tracking...')
    engine.stopTracking()
  })
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
