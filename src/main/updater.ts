import { app, BrowserWindow, Notification, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'
import { promises as fs } from 'fs'
import { join } from 'path'
import log from 'electron-log'

autoUpdater.logger = log
// @ts-ignore
autoUpdater.logger.transports.file.level = 'info'
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

let feedConfigured = false
let isDownloading = false           // prevents concurrent download attempts
let downloadedVersion: string | null = null  // version already downloaded — skip re-downloading
let lastForceNonce: string | null = null     // tracks admin-triggered force-check nonce

// ─── macOS asar-only updater ─────────────────────────────────────────────────
// On macOS we skip electron-updater (which replaces the full app bundle and
// causes macOS to revoke accessibility permissions for unsigned apps).
// Instead we download only app.asar, save it to userData, and apply it on restart.
// The Electron binary never changes → macOS keeps the accessibility grant.

const PENDING_ASAR = () => join(app.getPath('userData'), 'pending-app-update.asar')

function semverGt(a: string, b: string): boolean {
  const parse = (v: string) => v.split('.').map(Number)
  const [a1, a2, a3] = parse(a)
  const [b1, b2, b3] = parse(b)
  if (a1 !== b1) return a1 > b1
  if (a2 !== b2) return a2 > b2
  return a3 > b3
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
  const buffer = await response.arrayBuffer()
  await fs.writeFile(dest, Buffer.from(buffer))
}

// Shared /latest fetch — used by both macOS and Windows/Linux polls
async function fetchLatest(apiBaseUrl: string): Promise<any | null> {
  try {
    const res = await fetch(`${apiBaseUrl}/system/agent-release/latest`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } catch (e: any) {
    log.error('[Updater] fetchLatest failed:', e.message)
    return null
  }
}

async function checkForMacAsarUpdate(apiBaseUrl: string, forced = false): Promise<void> {
  if (isDownloading && !forced) return
  try {
    log.info('[AsarUpdater] Checking for update...')
    const data = await fetchLatest(apiBaseUrl)
    if (!data) return

    // React to admin force-check nonce
    const nonce: string | null = data.force_check_nonce ?? null
    const nonceChanged = nonce && nonce !== lastForceNonce
    if (nonceChanged) {
      lastForceNonce = nonce
      log.info('[AsarUpdater] Force-check triggered by admin.')
    }

    const macos = data.macos as { version: string; asar_url?: string | null } | undefined
    if (!macos?.version) return

    const current = app.getVersion()
    if (!semverGt(macos.version, current)) {
      log.info(`[AsarUpdater] Up to date (v${current}).`)
      return
    }

    if (!macos.asar_url) {
      log.info('[AsarUpdater] Newer version exists but no asar_url — skipping.')
      return
    }

    if (isDownloading) return
    if (downloadedVersion === macos.version) return  // already downloaded, waiting for user to restart

    isDownloading = true

    log.info(`[AsarUpdater] Update available: v${macos.version}. Downloading asar...`)
    BrowserWindow.getAllWindows().forEach(w =>
      w.webContents.send('update-available', macos.version)
    )

    await downloadToFile(macos.asar_url, PENDING_ASAR())

    isDownloading = false
    downloadedVersion = macos.version
    log.info(`[AsarUpdater] v${macos.version} asar ready in userData.`)
    BrowserWindow.getAllWindows().forEach(w =>
      w.webContents.send('update-downloaded', macos.version)
    )

    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'WorkPulse HR Update Ready',
        body: `v${macos.version} is downloaded. Restart the app to install it.`,
      })
      n.on('click', () => {
        BrowserWindow.getAllWindows().forEach(w => { w.show(); w.focus() })
      })
      n.show()
    }
  } catch (e: any) {
    isDownloading = false
    log.error('[AsarUpdater] Error:', e.message)
  }
}

// Windows/Linux: poll /latest every minute to catch new versions and admin force-checks
async function pollForUpdates(apiBaseUrl: string): Promise<void> {
  if (isDownloading) return
  try {
    const data = await fetchLatest(apiBaseUrl)
    if (!data) return

    // React to admin force-check nonce
    const nonce: string | null = data.force_check_nonce ?? null
    const nonceChanged = nonce && nonce !== lastForceNonce
    if (nonceChanged) {
      lastForceNonce = nonce
      log.info('[Updater] Force-check triggered by admin.')
      isDownloading = true
      autoUpdater.checkForUpdates()
        .catch(e => { log.error('[Updater] Force checkForUpdates failed:', e.message); isDownloading = false })
      return
    }

    // Normal version comparison against /latest
    const osKey = process.platform === 'win32' ? 'windows' : 'linux'
    const latest: string | undefined = data[osKey]?.version
    if (latest && semverGt(latest, app.getVersion()) && latest !== downloadedVersion) {
      log.info(`[Updater] Newer v${latest} found. Triggering download...`)
      isDownloading = true
      autoUpdater.checkForUpdates()
        .catch(e => { log.error('[Updater] checkForUpdates failed:', e.message); isDownloading = false })
    }
  } catch (e: any) {
    log.error('[Updater] pollForUpdates error:', e.message)
  }
}
// ─────────────────────────────────────────────────────────────────────────────

export function initializeUpdater() {
  if (!app.isPackaged) {
    log.info('[Updater] Skipping — dev mode.')
    return
  }

  // macOS uses asar-only updates to preserve accessibility permission
  if (process.platform === 'darwin') {
    log.info('[Updater] macOS: using asar-only update path.')
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

  autoUpdater.on('update-not-available', () => {
    isDownloading = false
  })

  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent)
    log.info(`[Updater] Downloading: ${pct}% (${Math.round(progress.bytesPerSecond / 1024)} KB/s)`)
    BrowserWindow.getAllWindows().forEach(w =>
      w.webContents.send('update-download-progress', pct)
    )
  })

  autoUpdater.on('update-downloaded', (info) => {
    isDownloading = false
    downloadedVersion = info.version
    log.info(`[Updater] v${info.version} downloaded. Will install on next quit.`)
    BrowserWindow.getAllWindows().forEach(w =>
      w.webContents.send('update-downloaded', info.version)
    )
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
    isDownloading = false
    log.error('[Updater] Error:', err.message)
  })
}

/**
 * Called after login once we know the API base URL.
 * Starts the 1-minute polling loop for all platforms.
 */
export function setFeedUrl(apiBaseUrl: string) {
  if (!app.isPackaged) return

  if (process.platform === 'darwin') {
    if (feedConfigured) return
    feedConfigured = true
    // First check after 10s, then every 1 minute
    setTimeout(() => checkForMacAsarUpdate(apiBaseUrl), 10_000)
    setInterval(() => checkForMacAsarUpdate(apiBaseUrl), 60_000)
    return
  }

  if (process.platform === 'linux' && !process.env.APPIMAGE) return

  try {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: `${apiBaseUrl}/system/agent-release`,
    })

    if (!feedConfigured) {
      feedConfigured = true
      // First check after 10s, then poll every 1 minute
      setTimeout(() => pollForUpdates(apiBaseUrl), 10_000)
      setInterval(() => pollForUpdates(apiBaseUrl), 60_000)
    }
  } catch (e: any) {
    log.error('[Updater] setFeedURL failed:', e.message)
  }
}

/** Called from IPC when user clicks "Restart to Update" in the renderer. */
export function installUpdate() {
  if (process.platform === 'darwin') {
    const pending = PENDING_ASAR()
    const target = join(process.resourcesPath, 'app.asar')

    log.info(`[AsarUpdater] Applying update: ${pending} → ${target}`)

    fs.copyFile(pending, target)
      .then(() => fs.unlink(pending))
      .then(() => {
        log.info('[AsarUpdater] Swap done. Relaunching...')
        app.relaunch()
        app.exit(0)
      })
      .catch((err: any) => {
        log.error('[AsarUpdater] Failed to apply asar:', err.message)
        dialog.showErrorBox(
          'Update Failed',
          `Could not apply the update (${err.message}).\n\nPlease reinstall WorkPulse Agent from the download page.`
        )
      })
    return
  }

  autoUpdater.quitAndInstall(false, true)
}
