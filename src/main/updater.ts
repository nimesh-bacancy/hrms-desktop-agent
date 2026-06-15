import { app, BrowserWindow, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'
import log from 'electron-log'

autoUpdater.logger = log
// @ts-ignore
autoUpdater.logger.transports.file.level = 'info'
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

let feedConfigured = false

export function initializeUpdater() {
  // Wire up event listeners once — feed URL set later via setFeedUrl()
  if (!app.isPackaged) {
    log.info('[Updater] Skipping — dev mode.')
    return
  }

  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    log.info('[Updater] Skipping — Linux .deb/.snap must update via package manager.')
    return
  }

  autoUpdater.on('checking-for-update', () => {
    log.info('[Updater] Checking for update...')
  })

  autoUpdater.on('update-available', (info) => {
    log.info(`[Updater] Update available: v${info.version}. Downloading...`)
    BrowserWindow.getAllWindows().forEach(w =>
      w.webContents.send('update-available', info.version)
    )
  })

  autoUpdater.on('update-not-available', (info) => {
    log.info(`[Updater] Up to date (v${info.version}).`)
  })

  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent)
    log.info(`[Updater] Downloading: ${pct}% (${Math.round(progress.bytesPerSecond / 1024)} KB/s)`)
    BrowserWindow.getAllWindows().forEach(w =>
      w.webContents.send('update-download-progress', pct)
    )
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`[Updater] v${info.version} downloaded. Will install on next quit.`)
    // Notify renderer to show "Restart to Update" button
    BrowserWindow.getAllWindows().forEach(w =>
      w.webContents.send('update-downloaded', info.version)
    )
    // Also show OS notification
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'WorkPulse HR Update Ready',
        body: `v${info.version} is downloaded. Restart the app to install it.`,
      })
      n.on('click', () => {
        BrowserWindow.getAllWindows().forEach(w => { w.show(); w.focus() })
      })
      n.show()
    }
  })

  autoUpdater.on('error', (err) => {
    log.error('[Updater] Error:', err.message)
  })
}

/**
 * Called after login once we know the API base URL.
 * Points electron-updater at the backend's release feed and triggers a check.
 */
export function setFeedUrl(apiBaseUrl: string) {
  if (!app.isPackaged) return
  if (process.platform === 'linux' && !process.env.APPIMAGE) return

  try {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: `${apiBaseUrl}/system/agent-release`,
    })

    if (!feedConfigured) {
      feedConfigured = true
      // Delay first check so it doesn't race with app startup
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch(e =>
          log.error('[Updater] checkForUpdates failed:', e.message)
        )
      }, 10_000)

      // Recheck every 4 hours
      setInterval(() => {
        autoUpdater.checkForUpdates().catch(e =>
          log.error('[Updater] Periodic check failed:', e.message)
        )
      }, 4 * 60 * 60 * 1000)
    }
  } catch (e: any) {
    log.error('[Updater] setFeedURL failed:', e.message)
  }
}

/** Called from IPC when user clicks "Restart to Update" in the renderer. */
export function installUpdate() {
  autoUpdater.quitAndInstall(false, true) // isSilent=false, isForceRunAfter=true
}
