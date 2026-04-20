import { app, shell, BrowserWindow, ipcMain, powerMonitor, Notification, Tray, Menu } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log'
import icon from '../../resources/icon.png?asset'
import { DesktopEngine } from './engine'
import { initializeUpdater } from './updater'

// Initialize Tracking Engine early
const engine = new DesktopEngine()
let tray: Tray | null = null
let mainWindow: BrowserWindow | null = null
let isQuitting = false

// Detect if we were launched by an autostart mechanism
const isAutoLaunched = process.argv.includes('--autostart')

function createWindow(): void {
  // Create the browser window.
  mainWindow = new BrowserWindow({
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
    // If launched via autostart, stay hidden in tray — don't pop up on every boot
    if (!isAutoLaunched) {
      if (mainWindow) mainWindow.show()
    } else {
      log.info('Auto-launched: starting silently in tray.')
    }
  })

  // Prevent window from being destroyed — hide instead
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      if (mainWindow) mainWindow.hide()
    }
    return false
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

// Initialization
app.whenReady().then(() => {
  // Create Tray Icon
  tray = new Tray(icon)
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open WorkPulse', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit WorkPulse', click: () => {
        isQuitting = true
        app.quit()
      } 
    }
  ])
  tray.setToolTip('WorkPulse Desktop Agent')
  tray.setContextMenu(contextMenu)
  tray.on('click', () => {
    mainWindow?.show()
  })

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC handlers for Authentication & Tracking Control
  ipcMain.on('save-auth', (_, { url, token }) => {
    engine.setAuth(url, token)
  })

  ipcMain.on('logout', () => {
    // Option B: Don't stop tracking — just disconnect locally.
    // The attendance session keeps running on the server and will
    // resume correctly when the user logs back in.
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

  // Provide engine status and start time to the renderer
  ipcMain.handle('get-engine-status', () => {
    return engine.getStatus()
  })

  // Explicit quit from UI
  ipcMain.on('app-quit', () => {
    log.info('Quit requested via IPC.')
    isQuitting = true
    app.quit()
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

  // ── Cross-platform Autostart ──────────────────────────────────────────────
  // Linux: Write/delete XDG .desktop file in ~/.config/autostart/
  // Windows/Mac: Use Electron's native login item settings
  const getLinuxAutostartPath = () => {
    const configDir = join(app.getPath('home'), '.config', 'autostart')
    return join(configDir, 'workpulse-agent.desktop')
  }

  const getLinuxDesktopContent = () => {
    const execPath = process.execPath
    return [
      '[Desktop Entry]',
      'Type=Application',
      'Name=WorkPulse Agent',
      `Exec="${execPath}" --autostart`,
      'Icon=workpulse-agent',
      'Comment=WorkPulse Desktop Tracking Agent',
      'Categories=Utility;',
      'Terminal=false',
      'Hidden=false',
      'X-GNOME-Autostart-enabled=true',
    ].join('\n') + '\n'
  }

  const getLinuxAutostartStatus = async (): Promise<boolean> => {
    try {
      await fs.access(getLinuxAutostartPath())
      return true
    } catch {
      return false
    }
  }

  ipcMain.on('set-launch-at-startup', async (_, openAtLogin: boolean) => {
    if (process.platform === 'linux') {
      try {
        const autostartPath = getLinuxAutostartPath()
        const configDir = join(app.getPath('home'), '.config', 'autostart')
        if (openAtLogin) {
          await fs.mkdir(configDir, { recursive: true })
          await fs.writeFile(autostartPath, getLinuxDesktopContent(), 'utf8')
          log.info(`Autostart enabled: wrote ${autostartPath}`)
        } else {
          await fs.unlink(autostartPath).catch(() => {}) // ignore if not exists
          log.info(`Autostart disabled: removed ${autostartPath}`)
        }
      } catch (e) {
        log.error('Failed to set Linux autostart:', e)
      }
    } else {
      app.setLoginItemSettings({
        openAtLogin,
        openAsHidden: true, // Start silently in tray on Windows/Mac
        path: app.getPath('exe')
      })
    }
  })

  ipcMain.handle('get-launch-at-startup', async () => {
    if (process.platform === 'linux') {
      return await getLinuxAutostartStatus()
    }
    const settings = app.getLoginItemSettings()
    return settings.openAtLogin
  })
  // ──────────────────────────────────────────────────────────────────────────

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

// Keep the app running even when windows are closed
app.on('window-all-closed', () => {
  // We handle background operation via Tray, so we do nothing here
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
    isQuitting = true
    log.info('Application quitting. Stopping tracking...')
    engine.stopTracking()
  })
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
