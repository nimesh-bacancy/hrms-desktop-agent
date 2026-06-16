import { app, shell, BrowserWindow, ipcMain, powerMonitor, Notification, Tray, Menu, dialog } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log'
import icon from '../../resources/icon.png?asset'
import { DesktopEngine } from './engine'
import { initializeUpdater, setFeedUrl, installUpdate } from './updater'

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
    { label: 'Open WorkPulse HR', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit WorkPulse HR', click: async () => {
        if (engine.getStatus().isTracking) {
          const { response } = await dialog.showMessageBox({
            type: 'warning',
            title: 'Agent is still tracking',
            message: 'Quitting will turn off the WorkPulse HR agent and stop monitoring.',
            detail: 'Use "Stop Tracking" inside the app instead of quitting, so your session closes cleanly.\n\nIf you quit now your attendance session will stay open until the end-of-day auto-close.',
            buttons: ['Keep Agent Running', 'Stop Tracking & Quit'],
            defaultId: 0,
            cancelId: 0,
          })
          if (response === 0) return // user chose to keep it running
          // response === 1 → stop tracking gracefully then quit
          await engine.stopTracking()
        }
        isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setToolTip('WorkPulse HR Desktop Agent')
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

  // Session expired — OS notification + bring window forward so user sees it
  const showSessionExpiredNotification = () => {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'WorkPulse HR — Session Expired',
        body: 'Your session has expired. Please log in again to continue tracking.',
        urgency: 'critical',
      })
      n.on('click', () => {
        mainWindow?.show()
        mainWindow?.focus()
      })
      n.show()
    }
    // Restore window so the user can act on it
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  }

  // Session expired — show OS notification and restore window
  engine.onSessionExpired = showSessionExpiredNotification

  // Notify renderer + show OS notification when a screenshot is taken
  engine.onScreenshotTaken = () => {
    const wins = BrowserWindow.getAllWindows()
    wins.forEach(w => w.webContents.send('screenshot-taken'))
    if (Notification.isSupported()) {
      new Notification({
        title: 'WorkPulse HR',
        body: 'Screenshot captured by your administrator.',
        silent: true,
      }).show()
    }
  }

  // IPC handlers for Authentication & Tracking Control
  ipcMain.on('save-auth', (_, { url, token, tenantId, refreshToken }) => {
    engine.setAuth(url, token, tenantId ?? null)
    if (refreshToken) engine.setRefreshToken(refreshToken)
    // Wire updater feed URL now that we know where the backend lives
    if (url) setFeedUrl(url)
  })

  // Renderer requests a token refresh (called when engine gets 401)
  ipcMain.handle('refresh-token', async () => {
    return await engine.refreshAccessToken()
  })

  // User clicked "Restart to Update" in the renderer
  ipcMain.on('install-update', () => {
    installUpdate()
  })

  ipcMain.on('logout', () => {
    // Option B: Don't stop tracking — just disconnect locally.
    // The attendance session keeps running on the server and will
    // resume correctly when the user logs back in.
    engine.revokeRefreshToken()
    engine.setAuth('', '')
  })

  ipcMain.on('start-tracking', () => {
    engine.startTracking()
  })

  // Renderer reports accumulated mouse/keyboard activity count each pulse interval
  ipcMain.on('report-activity', (_, { mouseMovement }: { mouseMovement: number }) => {
    engine.setActivityCount(mouseMovement)
  })

  ipcMain.on('stop-tracking', () => {
    engine.stopTracking()
  })

  // Provide realtime idle time to the frontend dashboard
  ipcMain.handle('get-idle-time', () => {
    return powerMonitor.getSystemIdleTime()
  })

  ipcMain.handle('get-app-version', () => {
    return app.getVersion()
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
        title: 'WorkPulse HR: Are you still working?',
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
    // app.getPath('exe') returns the AppImage path in production; process.execPath
    // returns the inner electron binary (wrong). Always prefer exe path.
    const execPath = app.getPath('exe')
    return [
      '[Desktop Entry]',
      'Type=Application',
      'Name=WorkPulse HR Agent',
      `Exec="${execPath}" --autostart`,
      'Icon=workpulse-agent',
      'Comment=WorkPulse HR Desktop Tracking Agent',
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
      // Only write autostart in production — in dev, process.execPath / app.getPath('exe')
      // both point to the raw electron binary which opens Electron boilerplate, not the app.
      if (!app.isPackaged) {
        log.info('Autostart skipped: not a packaged build (dev mode).')
        return
      }
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
      if (!app.isPackaged) return false // dev mode: treat as disabled
      return await getLinuxAutostartStatus()
    }
    const settings = app.getLoginItemSettings()
    return settings.openAtLogin
  })
  // ──────────────────────────────────────────────────────────────────────────

  ipcMain.on('set-break-state', (_, onBreak: boolean) => {
    engine.setBreakState(onBreak)
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

  // Graceful shutdown — best-effort stop on any quit path (OS shutdown, kill signal, etc.)
  // The tray "Quit" handler already does a clean async stopTracking(); this is a safety net.
  app.on('before-quit', () => {
    isQuitting = true
    log.info('Application quitting. Stopping tracking...')
    if (engine.getStatus().isTracking) {
      engine.stopTracking()
    }
  })
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
