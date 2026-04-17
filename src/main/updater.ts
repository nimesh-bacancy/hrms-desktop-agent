import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import log from 'electron-log'

autoUpdater.logger = log
// @ts-ignore
autoUpdater.logger.transports.file.level = 'info'
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

export function initializeUpdater() {
  // Never run auto-update in dev mode — the app is not packaged and has no version to compare
  if (!app.isPackaged) {
    log.info('[Updater] Skipping update check — running in dev mode.')
    return
  }

  // On Linux, electron-updater only supports auto-update when running as AppImage.
  // .deb and .snap installs do not support this mechanism — skip gracefully.
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    log.info('[Updater] Skipping update check — Linux install is not an AppImage (deb/snap installs must update manually).')
    return
  }

  autoUpdater.on('checking-for-update', () => {
    log.info('[Updater] Checking for update...')
  })

  autoUpdater.on('update-available', (info) => {
    log.info(`[Updater] Update available: v${info.version}. Downloading...`)
  })

  autoUpdater.on('update-not-available', (info) => {
    log.info(`[Updater] App is up to date (v${info.version}).`)
  })

  autoUpdater.on('download-progress', (progress) => {
    log.info(`[Updater] Download progress: ${Math.round(progress.percent)}% (${Math.round(progress.bytesPerSecond / 1024)} KB/s)`)
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`[Updater] Update v${info.version} downloaded. Will install on next quit.`)
  })

  autoUpdater.on('error', (err) => {
    log.error('[Updater] Auto-update error:', err.message)
  })

  // Delay the first check by 10s so it doesn't compete with app startup
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.error('[Updater] checkForUpdates failed:', err.message)
    })
  }, 10000)
}
