/**
 * DesktopEngine — WorkPulse HR tracking core
 *
 * Ghost-time prevention principles:
 *  1. Heartbeat is presence-only — never writes activity records
 *  2. Pulses only sent when isTracking = true AND attendanceId is confirmed
 *  3. attendanceId is cleared immediately on any clock-out (success or fail)
 *  4. forceStop() is the only path that kills tracking from sendOrQueuePulse
 *  5. isPulseRunning is always released in runPulse's finally — no deadlocks
 *  6. Agent config is fetched from server (screenshot_enabled, interval)
 */

import { app, powerMonitor, desktopCapturer, BrowserWindow, systemPreferences } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import axios from 'axios'
import log from 'electron-log'

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

interface AgentConfig {
  screenshot_enabled: boolean
  screenshot_interval_minutes: number // 1–60
}

const DEFAULT_CONFIG: AgentConfig = {
  screenshot_enabled: true,
  screenshot_interval_minutes: 10,
}

export class DesktopEngine {
  // ── State ───────────────────────────────────────────────────────────────────
  private isTracking = false
  private attendanceId: number | null = null
  private isLocked = false
  private isOnBreak = false
  private trackingStartTime: string | null = null
  private trackingDate: string | null = null

  // ── Concurrency guards ───────────────────────────────────────────────────────
  private isPulseRunning = false
  private isSyncingQueue = false
  private pendingEvent: string | null = null

  // ── Intervals ───────────────────────────────────────────────────────────────
  private heartbeatInterval: NodeJS.Timeout | null = null
  private pulseInterval: NodeJS.Timeout | null = null
  private configRefreshInterval: NodeJS.Timeout | null = null

  // ── Screenshot state ────────────────────────────────────────────────────────
  private lastScreenshotAt: number = 0

  // ── Activity intensity (mouse moves + keystrokes from renderer) ─────────────
  private activityCount: number = 0

  // ── Auth ────────────────────────────────────────────────────────────────────
  private apiUrl = ''
  private token = ''
  private tenantId: number | null = null

  // ── Config from server ──────────────────────────────────────────────────────
  private agentConfig: AgentConfig = { ...DEFAULT_CONFIG }

  // ── Timezone (waited on before first clock-in) ──────────────────────────────
  private userTimezone = 'UTC'
  private _tzReadyResolve: (() => void) | null = null
  private _tzReady: Promise<void> = new Promise(r => { this._tzReadyResolve = r })

  // ── Offline queue file ──────────────────────────────────────────────────────
  private readonly queueFilePath: string

  // ── Screenshot notification callback ────────────────────────────────────────
  onScreenshotTaken: (() => void) | null = null

  // ── Session expired callback ─────────────────────────────────────────────────
  onSessionExpired: (() => void) | null = null

  constructor() {
    this.queueFilePath = join(app.getPath('userData'), 'wp_queue.json')
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  private L(msg: string) { log.info(`[Engine] ${msg}`) }

  private get headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      ...(this.tenantId ? { 'X-Tenant-ID': String(this.tenantId) } : {}),
    }
  }

  /** Pulse always runs every 60 seconds for accurate activity tracking */
  private readonly pulseMs = 60_000

  /** Screenshot fires when this many ms have passed since the last one */
  private get screenshotIntervalMs(): number {
    const mins = Math.max(1, Math.min(60, this.agentConfig.screenshot_interval_minutes))
    return mins * 60_000
  }

  private shouldTakeScreenshot(eventType: string | null): boolean {
    if (!this.agentConfig.screenshot_enabled) return false
    if (this.isOnBreak || this.isLocked) return false
    if (eventType === 'heartbeat' || eventType === 'agent_stop') return false
    // Always check elapsed time — including agent_start, to prevent a screenshot
    // firing on every clock-out + restart within the same interval window.
    return (Date.now() - this.lastScreenshotAt) >= this.screenshotIntervalMs
  }

  private currentDateInTz(): string {
    try {
      return new Date().toLocaleDateString('en-CA', { timeZone: this.userTimezone })
    } catch {
      return new Date().toLocaleDateString('en-CA')
    }
  }

  // ── Auth / init ─────────────────────────────────────────────────────────────
  public setAuth(apiUrl: string, token: string, tenantId?: number | null) {
    if (tenantId !== undefined) this.tenantId = tenantId ?? null

    const hadToken = !!this.token
    const loggingOut = hadToken && !token
    const sameToken = hadToken && token === this.token
    const loggingIn = !hadToken && !!token

    this.apiUrl = apiUrl
    this.token = token

    // ── Logout: pause everything, preserve tracking state for re-auth ──
    if (loggingOut) {
      this.stopIntervals()
      this.L('Logged out — intervals paused, tracking state preserved.')
      return
    }

    // ── Same token re-sent (renderer refresh): do nothing extra ──
    if (sameToken) {
      this.syncOfflineQueue()
      return
    }

    // ── Fresh login or re-auth after logout ──
    if (loggingIn) {
      // Reset timezone gate
      this._tzReady = new Promise(r => { this._tzReadyResolve = r })
      this.fetchUserTimezone()
      this.fetchAndApplyAgentConfig()
      this.startHeartbeat()

      // If we were tracking before logout, resume pulse loop
      if (this.isTracking) {
        this.L('Re-authenticated — resuming tracking.')
        this.restartPulseInterval()
        // Send a recovery pulse to register we're back online
        this.runPulse('agent_start')
      }

      this.syncOfflineQueue()
      return
    }

    // Fallback: token refreshed in-place (same session, token rotated)
    if (!this.heartbeatInterval) {
      this._tzReady = new Promise(r => { this._tzReadyResolve = r })
      this.fetchUserTimezone()
      this.fetchAndApplyAgentConfig()
      this.startHeartbeat()
    }
    this.syncOfflineQueue()
  }

  // ── Heartbeat — presence only, never writes activity ────────────────────────
  private startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
    // No immediate fire — interval only, to prevent ghost pulses on startup/re-auth
    this.heartbeatInterval = setInterval(() => {
      if (!this.isTracking && this.token) this.sendPresenceHeartbeat()
    }, 5 * 60_000)
    this.L('Heartbeat started (5 min interval, presence-only).')
  }

  private async sendPresenceHeartbeat() {
    if (!this.token || !this.apiUrl) return
    try {
      await axios.post(`${this.apiUrl}/attendance/heartbeat`, {}, {
        headers: this.headers, timeout: 8000,
      })
    } catch {
      // Silent — offline is fine
    }
  }

  // ── Agent config ─────────────────────────────────────────────────────────────
  private async fetchAndApplyAgentConfig() {
    try {
      const { data } = await axios.get(`${this.apiUrl}/activities/agent-config`, {
        headers: this.headers, timeout: 8000,
      })
      if (!data) return

      const prevInterval = this.agentConfig.screenshot_interval_minutes
      const prevEnabled = this.agentConfig.screenshot_enabled

      const newInterval: number = data.screenshot_interval_minutes ?? 10
      const newEnabled: boolean = data.screenshot_enabled ?? true

      this.agentConfig = {
        screenshot_enabled: newEnabled,
        screenshot_interval_minutes: newInterval,
      }

      // If interval changed, reset lastScreenshotAt so the new interval is measured from now.
      // This ensures changes take effect on the very next pulse cycle rather than from the
      // previous screenshot's timestamp.
      if (newInterval !== prevInterval || newEnabled !== prevEnabled) {
        this.L(`Config changed: screenshot_enabled=${newEnabled} (was ${prevEnabled}), interval=${newInterval}min (was ${prevInterval}min)`)
        // Reset to (now - newInterval + 1min) so next pulse fires at correct time.
        // If new interval is shorter than elapsed time, fire immediately on next pulse.
        this.lastScreenshotAt = Date.now() - (newInterval * 60_000 - this.pulseMs)
      } else {
        this.L(`Config: screenshot_enabled=${newEnabled}, screenshot_interval=${newInterval}min (unchanged)`)
      }
    } catch (e) {
      this.L(`Agent config fetch failed (using defaults): ${getErrorMessage(e)}`)
    }

    // Refresh every 60s (matches pulse interval) so admin changes take effect within 1 minute
    if (!this.configRefreshInterval) {
      this.configRefreshInterval = setInterval(() => this.fetchAndApplyAgentConfig(), 60_000)
    }
  }

  // ── Timezone ─────────────────────────────────────────────────────────────────
  private async fetchUserTimezone() {
    try {
      const { data } = await axios.get(`${this.apiUrl}/users/me`, {
        headers: this.headers, timeout: 8000,
      })
      if (data?.timezone) {
        this.userTimezone = data.timezone
        this.L(`Timezone: ${this.userTimezone}`)
      }
    } catch (e) {
      this.L(`Timezone fetch failed (using ${this.userTimezone}): ${getErrorMessage(e)}`)
    } finally {
      if (this._tzReadyResolve) { this._tzReadyResolve(); this._tzReadyResolve = null }
    }
  }

  // ── Tracking start / stop ────────────────────────────────────────────────────
  public startTracking() {
    if (this.isTracking || !this.token) return
    this.isTracking = true
    // Reset lastScreenshotAt to now so the first screenshot is delayed by the full
    // configured interval — prevents an immediate screenshot on every tracking start.
    if (Date.now() - this.lastScreenshotAt >= this.screenshotIntervalMs) {
      this.lastScreenshotAt = Date.now()
    }
    this.restartPulseInterval()
    this.L('Tracking started.')

    this._tzReady.then(async () => {
      if (!this.isTracking) return
      const ok = await this.triggerClockIn()
      if (ok) {
        this.trackingStartTime = new Date().toISOString()
        this.trackingDate = this.currentDateInTz()
        this.runPulse('agent_start')
      } else {
        // Clock-in failed — abort tracking cleanly
        this.isTracking = false
        if (this.pulseInterval) { clearInterval(this.pulseInterval); this.pulseInterval = null }
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('force-stop'))
        this.L('Tracking aborted: clock-in failed.')
      }
    })
  }

  public async stopTracking() {
    if (!this.isTracking) return
    this.isTracking = false
    this.trackingStartTime = null
    this.trackingDate = null
    if (this.pulseInterval) { clearInterval(this.pulseInterval); this.pulseInterval = null }

    // Wait for any in-flight pulse
    if (this.isPulseRunning) {
      this.L('Waiting for in-flight pulse before agent_stop...')
      await new Promise<void>(resolve => {
        const poll = setInterval(() => { if (!this.isPulseRunning) { clearInterval(poll); resolve() } }, 100)
        setTimeout(() => { clearInterval(poll); resolve() }, 15_000) // 15s safety timeout
      })
    }

    await this.runPulse('agent_stop')
    await this.triggerClockOut()
    this.L('Tracking stopped.')
  }

  /** Called when server reports session is dead (401/403/404 on pulse) */
  public forceStop() {
    if (!this.isTracking) return
    this.isTracking = false
    this.trackingStartTime = null
    this.trackingDate = null
    if (this.pulseInterval) { clearInterval(this.pulseInterval); this.pulseInterval = null }
    // Best-effort: clear is_agent_active on the server so the UI shows disconnected.
    // Ignore errors — the session may already be dead (401) or closed.
    if (this.attendanceId && this.token) {
      this.attendanceId = null
      axios.post(`${this.apiUrl}/attendance/clock-out`, {}, {
        headers: this.headers, timeout: 5000,
      }).catch(() => {
        // Silently ignore — session was already dead (401/403) or network is gone
      })
    } else {
      this.attendanceId = null
    }
    this.L('Force-stopped (server session dead).')
  }

  // ── Clock in / out ───────────────────────────────────────────────────────────
  private async triggerClockIn(): Promise<boolean> {
    try {
      // Always check server state first — never double-clock-in
      const { data: status } = await axios.get(`${this.apiUrl}/attendance/status`, {
        headers: this.headers, timeout: 8000,
      })
      if (status?.is_clocked_in && status?.attendance_id) {
        this.attendanceId = status.attendance_id
        // Fix 8: Re-sync break state from server so a post-crash/re-auth agent
        // doesn't send active pulses while the server thinks the user is on break.
        if (typeof status.is_on_break === 'boolean') {
          this.isOnBreak = status.is_on_break
        }
        this.L(`Already clocked in (id=${this.attendanceId}, onBreak=${this.isOnBreak}).`)
        return true
      }
      const { data } = await axios.post(`${this.apiUrl}/attendance/clock-in`, {}, {
        headers: this.headers, timeout: 8000,
      })
      if (data?.id) {
        this.attendanceId = data.id
        this.L(`Clocked in (id=${this.attendanceId}).`)
        return true
      }
      return false
    } catch (e) {
      this.L(`Clock-in failed: ${getErrorMessage(e)}`)
      return false
    }
  }

  private async triggerClockOut() {
    // Clear attendanceId immediately — prevents ghost re-attachment if clock-out fails
    const id = this.attendanceId
    this.attendanceId = null
    if (!id) return
    try {
      await axios.post(`${this.apiUrl}/attendance/clock-out`, {}, {
        headers: this.headers, timeout: 8000,
      })
      this.L('Clocked out.')
    } catch (e: any) {
      const status = e?.response?.status
      if (status === 400) {
        // Session was already closed (auto-close, web clock-out, etc.) — not an error
        this.L('Clock-out skipped: session already closed server-side.')
        return
      }
      this.L(`Clock-out failed (${status ?? 'network'}): ${getErrorMessage(e)}`)
      BrowserWindow.getAllWindows().forEach(w =>
        w.webContents.send('clock-out-failed', 'Clock-out failed. Please clock out manually from the web app.')
      )
    }
  }

  // ── Pulse ─────────────────────────────────────────────────────────────────────
  private restartPulseInterval() {
    if (this.pulseInterval) clearInterval(this.pulseInterval)
    this.pulseInterval = setInterval(() => this.runPulse(), this.pulseMs) // always 60s
    this.L(`Pulse interval: 1 min | Screenshot interval: ${this.agentConfig.screenshot_interval_minutes} min`)
  }

  private async runPulse(eventType: string | null = null) {
    // One pulse at a time
    if (this.isPulseRunning) {
      this.L('Pulse skipped: previous still running.')
      return
    }
    this.isPulseRunning = true

    try {
      // Drain any deferred event from a busy pulse slot
      if (!eventType && this.pendingEvent) {
        eventType = this.pendingEvent
        this.pendingEvent = null
        this.L(`Deferred event picked up: ${eventType}`)
      }

      if (!this.token) return

      // Ensure we have an attendance ID — only when actively tracking
      if (eventType === 'agent_start' && !this.attendanceId) {
        const ok = await this.triggerClockIn()
        if (!ok) return
      }

      // Only fetch attendance if tracking and ID is missing
      if (!this.attendanceId && this.isTracking) {
        const found = await this.fetchCurrentAttendanceId()
        if (!found) {
          this.L('Pulse skipped: no active attendance on server.')
          return
        }
      }

      // No ID and not tracking = nothing to pulse (e.g. agent_stop after clock-out)
      if (!this.attendanceId) {
        this.L('Pulse skipped: no attendance ID.')
        return
      }

      // Snapshot before any async — forceStop() may null this.attendanceId during awaits
      const aid = this.attendanceId

      // Day-boundary rollover
      if (this.isTracking && this.trackingDate) {
        const today = this.currentDateInTz()
        if (today !== this.trackingDate) {
          this.L(`Day boundary: ${this.trackingDate} → ${today}`)
          setImmediate(() => this.executeMidnightRollover(today))
          return // isPulseRunning released in finally
        }
      }

      // System idle time
      const idleSec = powerMonitor.getSystemIdleTime()

      // Window tracking (skip on break/locked/Wayland)
      let windowTitle: string | null = null
      let appName: string | null = null
      if (!this.isOnBreak && !this.isLocked && !process.env.WAYLAND_DISPLAY) {
        try {
          const { activeWindow } = await import('get-windows')
          const w = await activeWindow()
          windowTitle = w?.title || null
          appName = w?.owner?.name || null
        } catch {
          // Native module unavailable — continue without window info
        }
      }

      // Screenshot — time-based, independent from pulse interval
      let screenshotKey: string | null = null
      if (this.shouldTakeScreenshot(eventType)) {
        // Always stamp the attempt time — prevents rapid retry loop when upload fails
        this.lastScreenshotAt = Date.now()
        screenshotKey = await this.takeAndUploadScreenshot()
      }

      // Active = not idle >3 min, not locked, not on break
      const isActive = !this.isOnBreak && !this.isLocked && idleSec < 180

      // Snapshot and reset activity counter
      const mouseMovement = this.activityCount
      this.activityCount = 0

      const payload = {
        attendance_id: aid,
        is_active: isActive,
        active_window: this.isOnBreak ? null : (this.isLocked ? 'Locked' : (windowTitle ?? 'Unknown')),
        app_name: this.isOnBreak ? null : (this.isLocked ? 'System' : appName),
        client_timestamp: new Date().toISOString(),
        platform: process.platform,
        event: eventType === 'heartbeat' ? null : eventType,
        mouse_movement: mouseMovement,
      }

      this.L(`Pulse: event=${payload.event ?? 'activity'} active=${isActive} idle=${idleSec}s break=${this.isOnBreak} locked=${this.isLocked}`)

      // Push window title to renderer UI
      if (!this.isOnBreak) {
        const label = this.isLocked ? 'Screen Locked' : (appName || windowTitle)
        if (label) BrowserWindow.getAllWindows().forEach(w => w.webContents.send('active-window-update', label))
      }

      await this.sendOrQueuePulse(payload, screenshotKey)

    } catch (e) {
      this.L(`runPulse error: ${getErrorMessage(e)}`)
    } finally {
      // Always release — no exceptions
      this.isPulseRunning = false
    }
  }

  private async fetchCurrentAttendanceId(): Promise<boolean> {
    try {
      const { data } = await axios.get(`${this.apiUrl}/attendance/status`, {
        headers: this.headers, timeout: 8000,
      })
      if (data?.is_clocked_in && data?.attendance_id) {
        this.attendanceId = data.attendance_id
        return true
      }
      this.attendanceId = null
      return false
    } catch (e) {
      this.L(`fetchAttendanceId failed: ${getErrorMessage(e)}`)
      return false
    }
  }

  // ── Screenshot ───────────────────────────────────────────────────────────────
  private async takeAndUploadScreenshot(): Promise<string | null> {
    this.L('Capturing screenshot...')

    // macOS permission check
    if (process.platform === 'darwin') {
      const access = systemPreferences.getMediaAccessStatus('screen')
      if (access !== 'granted') {
        this.L(`Screenshot skipped: macOS Screen Recording permission is '${access}'.`)
        return null
      }
    }

    let imgBuffer: Buffer
    try {
      const sources = await Promise.race([
        desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } }),
        new Promise<never>((_, r) => setTimeout(() => r(new Error('capture timeout')), 10_000)),
      ])
      if (!sources.length) { this.L('Screenshot: no sources (Wayland?)'); return null }
      imgBuffer = sources[0].thumbnail.toJPEG(85)
      if (imgBuffer.length < 1000) { this.L('Screenshot: empty thumbnail (permission denied?)'); return null }
      this.L(`Screenshot: ${imgBuffer.length} bytes`)
    } catch (e) {
      this.L(`Screenshot capture error: ${getErrorMessage(e)}`)
      return null
    }

    try {
      const { data: { url, fields } } = await axios.get(
        `${this.apiUrl}/activities/screenshot-upload-url`,
        { params: { file_name: 'screenshot.jpg', content_type: 'image/jpeg' }, headers: this.headers, timeout: 8000 }
      )
      if (!url || !fields) { this.L('Screenshot: no presigned URL'); return null }

      const form = new FormData()
      Object.entries(fields).forEach(([k, v]) => form.append(k, v as string))
      form.append('file', new Blob([new Uint8Array(imgBuffer)], { type: 'image/jpeg' }), 'screenshot.jpg')

      const { status } = await axios.post(url, form, { maxBodyLength: Infinity, timeout: 30_000 })
      if (![200, 204].includes(status)) { this.L(`Screenshot: S3 rejected (${status})`); return null }

      const key = fields['key'] as string
      this.L(`Screenshot uploaded: ${key}`)
      this.onScreenshotTaken?.()
      return key
    } catch (e: any) {
      if (e?.response?.status === 503) this.L('Screenshot: S3 not configured')
      else this.L(`Screenshot upload error: ${getErrorMessage(e)}`)
      return null
    }
  }

  // ── Midnight rollover ────────────────────────────────────────────────────────
  private async executeMidnightRollover(newDate: string) {
    if (this.isPulseRunning) return
    this.isPulseRunning = true
    this.L(`Midnight rollover: ${this.trackingDate} → ${newDate}`)

    try {
      const prevId = this.attendanceId
      if (prevId) {
        await this.sendOrQueuePulse({
          attendance_id: prevId, is_active: false, event: 'agent_stop',
          client_timestamp: new Date().toISOString(), platform: process.platform,
          active_window: null, app_name: null,
        }, null)
      }
      await this.triggerClockOut()

      const ok = await this.triggerClockIn()
      if (!ok) {
        this.L('Rollover: clock-in failed. Stopping.')
        this.isTracking = false
        if (this.pulseInterval) { clearInterval(this.pulseInterval); this.pulseInterval = null }
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('force-stop'))
        return
      }

      this.trackingDate = newDate
      this.trackingStartTime = new Date().toISOString()

      if (this.attendanceId) {
        await this.sendOrQueuePulse({
          attendance_id: this.attendanceId, is_active: true, event: 'agent_start',
          client_timestamp: new Date().toISOString(), platform: process.platform,
          active_window: null, app_name: null,
        }, null)
      }

      this.L(`Rollover done. Now tracking: ${newDate}`)
      BrowserWindow.getAllWindows().forEach(w => w.webContents.send('day-rolled-over'))
    } catch (e) {
      this.L(`Rollover error: ${getErrorMessage(e)}`)
    } finally {
      this.isPulseRunning = false
    }
  }

  // ── Offline queue ────────────────────────────────────────────────────────────
  private async sendOrQueuePulse(payload: any, screenshotKey: string | null) {
    const body = { ...payload, screenshot_url: screenshotKey }
    try {
      await axios.post(`${this.apiUrl}/activities/desktop-pulse`, body, {
        headers: this.headers, timeout: 10_000,
      })
      this.L('Pulse sent.')
      await this.syncOfflineQueue() // await to prevent concurrent sync races
    } catch (e: any) {
      const status = e?.response?.status
      if ([401, 403].includes(status)) {
        this.L(`Session expired (${status}) — force stopping.`)
        this.forceStop()
        this.onSessionExpired?.()
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('session-expired'))
        return
      }
      if (status === 404) {
        this.L(`Attendance not found (404) — force stopping.`)
        this.forceStop()
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('force-stop'))
        return
      }
      // Network/server error — queue for later
      this.L(`Pulse queued (offline): ${getErrorMessage(e)}`)
      try {
        let q: any[] = []
        try { q = JSON.parse(await fs.readFile(this.queueFilePath, 'utf8')) } catch {}
        if (q.length >= 500) {
          // Drop oldest 100 entries to prevent unbounded growth
          q = q.slice(100)
          this.L("Queue capped at 500 entries — oldest 100 dropped.")
        }
        // Fix 5: Stamp the date so stale cross-day pulses are discarded on replay
        q.push({ ...body, _queued_date: this.trackingDate })
        await fs.writeFile(this.queueFilePath, JSON.stringify(q))
      } catch (qe) { log.error('Queue write failed:', getErrorMessage(qe)) }
    }
  }

  public async syncOfflineQueue() {
    if (!this.token || !this.apiUrl || this.isSyncingQueue) return
    this.isSyncingQueue = true
    try {
      let queue: any[]
      try {
        queue = JSON.parse(await fs.readFile(this.queueFilePath, 'utf8'))
        await fs.writeFile(this.queueFilePath, '[]') // clear immediately
      } catch { return }

      if (!queue.length) return
      this.L(`Syncing ${queue.length} offline pulses...`)

      const failed: any[] = []
      for (const pulse of queue) {
        // Fix 5: Discard cross-day pulses — queued on a different tracking date
        const queuedDate: string | undefined = pulse._queued_date
        const { _queued_date, ...pulseBody } = pulse
        if (queuedDate && this.trackingDate && queuedDate !== this.trackingDate) {
          this.L(`Discarding stale queued pulse (queued: ${queuedDate}, current: ${this.trackingDate})`)
          continue
        }
        try {
          await axios.post(`${this.apiUrl}/activities/desktop-pulse`, pulseBody, {
            headers: this.headers, timeout: 8000,
          })
        } catch (e: any) {
          const s = e?.response?.status
          if (s === 401 || s === 403 || s === 404) continue // discard stale
          failed.push(pulse) // re-queue WITH _queued_date intact
        }
      }

      if (failed.length) {
        try {
          let current: any[] = []
          try { current = JSON.parse(await fs.readFile(this.queueFilePath, 'utf8')) } catch {}
          await fs.writeFile(this.queueFilePath, JSON.stringify([...failed, ...current]))
        } catch {}
        this.L(`Sync partial: ${failed.length} pulses re-queued.`)
      } else {
        this.L('Offline queue fully synced.')
      }
    } finally {
      this.isSyncingQueue = false
    }
  }

  // ── External state changes ───────────────────────────────────────────────────
  /** Called by renderer each time it reports accumulated mouse/keyboard count */
  public setActivityCount(count: number) {
    this.activityCount = Math.min(count, 10000) // sanity cap
  }

  public setBreakState(onBreak: boolean) {
    this.isOnBreak = onBreak
    this.L(`Break: ${onBreak}`)
    if (!this.isTracking) return
    const event = onBreak ? 'break_start' : 'break_end'
    if (this.isPulseRunning) { this.pendingEvent = event } else { this.runPulse(event) }
  }

  public setPowerState(isLocked: boolean) {
    this.isLocked = isLocked
    this.L(`Locked: ${isLocked}`)
    if (!this.isTracking) return
    const event = isLocked ? 'lock' : 'unlock'
    if (this.isPulseRunning) { this.pendingEvent = event } else { this.runPulse(event) }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  private stopIntervals() {
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null }
    if (this.pulseInterval) { clearInterval(this.pulseInterval); this.pulseInterval = null }
    if (this.configRefreshInterval) { clearInterval(this.configRefreshInterval); this.configRefreshInterval = null }
  }

  public getStatus() {
    return { isTracking: this.isTracking, startTime: this.trackingStartTime, token: !!this.token }
  }

  public destroy() { this.stopIntervals() }
}
