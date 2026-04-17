import { app, powerMonitor, desktopCapturer, BrowserWindow, systemPreferences } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import axios from 'axios'
import log from 'electron-log'
// import ioHook from '@tkomde/iohook' // We will enable this cautiously

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  return String(error)
}

export class DesktopEngine {
  private queueFilePath: string
  private isTracking: boolean = false
  private attendanceId: number | null = null
  private isLocked: boolean = false
  private trackingStartTime: string | null = null
  private heartbeatInterval: NodeJS.Timeout | null = null
  private pulseInterval: NodeJS.Timeout | null = null
  private isPulseRunning: boolean = false

  // Tracking State
  private pulsesSinceScreenshot: number = 0
  private nextScreenshotThreshold: number = 3
  private pendingEvent: string | null = null

  private isSyncingQueue: boolean = false

  // Day-boundary rollover
  private userTimezone: string = 'UTC'
  private trackingDate: string | null = null

  private log(msg: string) {
    log.info(`[Engine] ${msg}`);
  }

  private apiUrl: string = ''
  private token: string = ''

  constructor() {
    this.queueFilePath = join(app.getPath('userData'), 'workpulse_queue.json')
    this.initDatabase()
  }

  private initDatabase() {
    // We use a simple JSON file queue to avoid C++ compiler issues on Linux
  }

  public setAuth(apiUrl: string, token: string) {
    const hadToken = !!this.token
    const isLoggingOut = hadToken && !token
    const isLoggingIn = !hadToken && !!token

    this.apiUrl = apiUrl
    this.token = token

    if (isLoggingOut) {
      // Pause all intervals but keep isTracking + trackingStartTime intact
      if (this.pulseInterval) { clearInterval(this.pulseInterval); this.pulseInterval = null }
      if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null }
      this.log('Logged out — tracking state preserved, intervals paused.')
      return
    }

    if (isLoggingIn) {
      this.fetchUserTimezone()
      // Resume heartbeat immediately
      this.startHeartbeat()
      // If we were tracking before logout, resume the pulse loop
      if (this.isTracking) {
        this.log('Re-authenticated — resuming tracked session from preserved state.')
        this.pulseInterval = setInterval(() => this.runPulse(), 60000)
        this.runPulse('heartbeat') // immediate pulse to re-register with server
      }
      this.syncOfflineQueue()
      return
    }

    // First-time login (no prior token)
    if (this.token && !this.heartbeatInterval) {
      this.fetchUserTimezone()
      this.startHeartbeat()
    }
    this.syncOfflineQueue()
  }

  private startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
    // Send initial status heartbeat
    this.runPulse('heartbeat')
    // Repeat every 5 minutes to maintain "Online" status on dashboard
    this.heartbeatInterval = setInterval(() => {
      // Only heartbeat if NOT already tracking (tracking sends more frequent pulses)
      if (!this.isTracking) {
        this.runPulse('heartbeat')
      }
    }, 5 * 60 * 1000)
  }

  public startTracking() {
    if (this.isTracking || !this.token) return
    this.isTracking = true
    
    // Automatically Clock In and fetch Attendance first
    this.triggerClockIn().then((success) => {
      if (success) {
        this.trackingStartTime = new Date().toISOString()
        this.trackingDate = this.getCurrentDateInTimezone()
        // Fire an immediate pulse to register the 'agent_start'
        this.runPulse('agent_start')
      }
    })

    // Pulse every 60 seconds
    this.pulseInterval = setInterval(() => this.runPulse(), 60000)
    
    this.log("Tracking engine started.")
  }

  public async stopTracking() {
    if (!this.isTracking) return
    this.isTracking = false
    this.trackingStartTime = null
    this.trackingDate = null
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval)
      this.pulseInterval = null
    }

    // If a pulse is currently in flight, wait for it to finish so agent_stop is never dropped
    if (this.isPulseRunning) {
      this.log('Waiting for in-flight pulse to finish before sending agent_stop...')
      await new Promise<void>(resolve => {
        const poll = setInterval(() => {
          if (!this.isPulseRunning) {
            clearInterval(poll)
            resolve()
          }
        }, 100)
        // Safety timeout: don't wait more than 15 seconds
        setTimeout(() => { clearInterval(poll); resolve() }, 15000)
      })
    }

    // Fire closing pulse then Clock Out
    await this.runPulse('agent_stop')
    await this.triggerClockOut()
    this.log("Tracking engine stopped and Clocked Out.")
  }

  // Called when backend says user is no longer clocked in
  public forceStop() {
    if (!this.isTracking) return
    this.isTracking = false
    this.trackingStartTime = null
    this.trackingDate = null
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval)
      this.pulseInterval = null
    }
    this.attendanceId = null
    this.log("Tracking forcefully stopped because HRMS says user is clocked out.")
  }

  private getCurrentDateInTimezone(): string {
    try {
      return new Date().toLocaleDateString('en-CA', { timeZone: this.userTimezone }) // YYYY-MM-DD
    } catch {
      return new Date().toLocaleDateString('en-CA') // fallback to system tz
    }
  }

  private async fetchUserTimezone(): Promise<void> {
    try {
      const resp = await axios.get(`${this.apiUrl}/users/me`, {
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: 8000
      })
      if (resp.data?.timezone) {
        this.userTimezone = resp.data.timezone
        this.log(`User timezone: ${this.userTimezone}`)
      }
    } catch (e: unknown) {
      this.log(`Could not fetch user timezone, using ${this.userTimezone}: ${getErrorMessage(e)}`)
    }
  }

  private async executeMidnightRollover(newDate: string): Promise<void> {
    if (this.isPulseRunning) return
    this.isPulseRunning = true
    this.log(`Midnight rollover: ${this.trackingDate} → ${newDate} (${this.userTimezone})`)

    try {
      const prevAttendanceId = this.attendanceId

      // 1. Close previous day — send agent_stop pulse then clock out
      if (prevAttendanceId) {
        await this.sendOrQueuePulse({
          attendance_id: prevAttendanceId,
          is_active: false,
          event: 'agent_stop',
          client_timestamp: new Date().toISOString(),
          platform: process.platform,
          active_window: null,
          app_name: null
        }, null)
      }
      await this.triggerClockOut()

      // 2. Open new day — clock in then send agent_start pulse
      const ok = await this.triggerClockIn()
      if (!ok) {
        this.log('Midnight rollover: clock-in for new day failed. Stopping tracking.')
        this.isTracking = false
        if (this.pulseInterval) { clearInterval(this.pulseInterval); this.pulseInterval = null }
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('force-stop'))
        return
      }

      this.trackingDate = newDate
      this.trackingStartTime = new Date().toISOString()

      if (this.attendanceId) {
        await this.sendOrQueuePulse({
          attendance_id: this.attendanceId,
          is_active: true,
          event: 'agent_start',
          client_timestamp: new Date().toISOString(),
          platform: process.platform,
          active_window: null,
          app_name: null
        }, null)
      }

      this.log(`Midnight rollover complete. Now tracking date: ${newDate}`)
      BrowserWindow.getAllWindows().forEach(w => w.webContents.send('day-rolled-over'))
    } catch (e: unknown) {
      this.log(`Midnight rollover error: ${getErrorMessage(e)}`)
    } finally {
      this.isPulseRunning = false
    }
  }

  private async triggerClockIn(): Promise<boolean> {
    try {
      // First check if already clocked in to avoid 400 error
      const statusResp = await axios.get(`${this.apiUrl}/attendance/status`, {
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: 8000
      })
      if (statusResp.data && statusResp.data.is_clocked_in && statusResp.data.attendance_id) {
        this.attendanceId = statusResp.data.attendance_id
        this.log("Already Clocked In. Inheriting Attendance session.")
        return true
      }

      // If not clocked in, initiate it
      const resp = await axios.post(`${this.apiUrl}/attendance/clock-in`, {}, {
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: 8000
      })
      if (resp.data && resp.data.id) {
        this.attendanceId = resp.data.id
        this.log("Automatically Clocked In successfully.")
        return true
      }
      return false
    } catch (e: unknown) {
      this.log(`Failed to Clock In via agent: ${getErrorMessage(e)}`)
      return false
    }
  }

  public getStatus() {
    return {
      isTracking: this.isTracking,
      startTime: this.trackingStartTime,
      apiUrl: this.apiUrl,
      token: !!this.token // Just return if we have a token
    }
  }

  private async triggerClockOut(): Promise<void> {
    try {
      if (!this.attendanceId) return
      await axios.post(`${this.apiUrl}/attendance/clock-out`, {}, {
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: 8000
      })
      this.log("Automatically Clocked Out successfully.")
      this.attendanceId = null
    } catch (e: unknown) {
      this.log(`Failed to Clock Out via agent: ${getErrorMessage(e)}`)
    }
  }

  public setPowerState(isLocked: boolean) {
    this.isLocked = isLocked
    this.log(`Power state changed. Locked: ${isLocked}`)

    if (this.isTracking) {
      if (this.isPulseRunning) {
        // A pulse is already in flight — store the event so the next pulse picks it up
        this.pendingEvent = isLocked ? 'lock' : 'unlock'
        this.log(`Pulse busy — deferring ${this.pendingEvent} event to next pulse.`)
      } else {
        this.runPulse(isLocked ? 'lock' : 'unlock')
      }
    }
  }

  private async fetchAttendanceId(): Promise<boolean> {
    try {
      const resp = await axios.get(`${this.apiUrl}/attendance/status`, {
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: 8000
      })
      if (resp.data && resp.data.is_clocked_in && resp.data.attendance_id) {
        this.attendanceId = resp.data.attendance_id
        return true
      }
      this.attendanceId = null
      return false
    } catch (e: unknown) {
      this.log(`Failed to fetch attendance status: ${getErrorMessage(e)}`)
      return false
    }
  }

  private getRandomScreenshotThreshold(): number {
    return Math.floor(Math.random() * 3) + 3 // Randomly yields 3, 4, or 5 minutes
  }

  private async runPulse(eventType: string | null = null) {
    if (this.isPulseRunning) {
      this.log('Pulse skipped: previous pulse still in progress.')
      return
    }

    try {
      this.isPulseRunning = true

      // Pick up any deferred lock/unlock event from a busy pulse slot
      if (!eventType && this.pendingEvent) {
        eventType = this.pendingEvent
        this.pendingEvent = null
        this.log(`Picked up deferred event: ${eventType}`)
      }

      // If token is missing (logged out), skip silently — don't forceStop
      if (!this.token) {
        this.log('Pulse skipped: no auth token.')
        return
      }

      // Startup: ensure we have an attendance ID
      if (eventType === 'agent_start' && !this.attendanceId) {
        const ok = await this.triggerClockIn()
        if (!ok) return
      }

      // If no ID yet (e.g. heartbeat before tracking), try one fetch
      if (!this.attendanceId) {
        await this.fetchAttendanceId()
      }

      // FINAL CHECK: If still no ID, skip this pulse (don't force-stop, just wait for clock-in)
      if (!this.attendanceId) {
        return
      }
      // Snapshot the ID now — forceStop() can null this.attendanceId during async awaits below
      const snapshotAttendanceId = this.attendanceId

      // Day-boundary check: if midnight has passed in the user's timezone, roll over to new day
      if (this.isTracking && this.trackingDate) {
        const todayInUserTz = this.getCurrentDateInTimezone()
        if (todayInUserTz !== this.trackingDate) {
          this.log(`Day boundary crossed: ${this.trackingDate} → ${todayInUserTz} (${this.userTimezone})`)
          // Schedule rollover after this pulse slot releases isPulseRunning
          setTimeout(() => this.executeMidnightRollover(todayInUserTz), 0)
          return
        }
      }

      // Real idle detection via Electron's built-in powerMonitor
      // Returns seconds since last keyboard or mouse event — no native modules needed
      const idleTimeSeconds = powerMonitor.getSystemIdleTime()
      
      let activeWindowDetails: any = null
      // get-windows uses a native binary — dynamically import it so a missing/broken
      // native build cannot crash the main process at startup.
      // Also skip on Wayland (no X11 support in get-windows).
      const isWayland = !!process.env.WAYLAND_DISPLAY
      if (!isWayland) {
        try {
          const { activeWindow } = await import('get-windows')
          activeWindowDetails = await activeWindow()
        } catch (e: unknown) {
          this.log(`Window tracking failed (continuing pulse): ${getErrorMessage(e)}`)
        }
      }

      // Screenshots: only for tracking pulses, not heartbeats
      let screenshotKey: string | null = null
      if (eventType !== 'heartbeat') {
        this.pulsesSinceScreenshot++
        if (eventType === 'agent_start' || this.pulsesSinceScreenshot >= this.nextScreenshotThreshold) {
          try {
            this.log(`Triggering screenshot... (eventType=${eventType})`)
            screenshotKey = await this.takeAndUploadScreenshot()
            this.pulsesSinceScreenshot = 0
            this.nextScreenshotThreshold = this.getRandomScreenshotThreshold()
          } catch (e: unknown) {
            this.log(`Screenshot capture/upload failed: ${getErrorMessage(e)}`)
          }
        }
      }

      const payload = {
        attendance_id: snapshotAttendanceId,
        is_active: !this.isLocked && idleTimeSeconds < 180, // 3 min idle threshold
        active_window: this.isLocked ? 'Locked' : (activeWindowDetails?.title || 'Unknown'),
        app_name: this.isLocked ? 'System' : (activeWindowDetails?.owner?.name || null),
        client_timestamp: new Date().toISOString(),
        platform: process.platform,
        event: eventType === 'heartbeat' ? null : eventType // backend expects agent_start/stop or null
      }

      this.log(`Sending pulse: event=${payload.event}, attendance=${payload.attendance_id}, active=${payload.is_active}`)

      // Queue or Send
      await this.sendOrQueuePulse(payload, screenshotKey)


    } catch (e: unknown) {
      this.log(`Pulse creation failed: ${getErrorMessage(e)}`)
    } finally {
      // In case sendOrQueuePulse wasn't reached, release the lock here
      if (this.isPulseRunning && eventType === 'agent_start') {
         // for agent_start, we might want to be careful, but generally we must release
      }
      this.isPulseRunning = false
    }
  }

  private async takeAndUploadScreenshot(): Promise<string | null> {
    // Step 1: Capture screenshot using Electron's desktopCapturer (no external OS tools needed)
    this.log('Capturing screen...')
    let imgBuffer: Buffer

    try {
      // macOS 10.15+: check Screen Recording permission before attempting capture.
      // Without it, getSources() succeeds but thumbnails are empty black images.
      if (process.platform === 'darwin') {
        const access = systemPreferences.getMediaAccessStatus('screen')
        if (access !== 'granted') {
          this.log(`Screenshot skipped: macOS Screen Recording permission is '${access}'. Grant it in System Settings → Privacy & Security → Screen Recording.`)
          return null
        }
      }

      const capturePromise = desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Screenshot capture timed out after 10s')), 10000)
      )
      const sources = await Promise.race([capturePromise, timeoutPromise])

      if (!sources.length) {
        // Common on Linux Wayland without PipeWire — skip gracefully
        this.log('Screenshot capture failed: no screen sources found (Wayland without PipeWire?)')
        return null
      }

      imgBuffer = sources[0].thumbnail.toJPEG(85)

      // Guard against empty thumbnails (macOS permission silently denied, or Wayland fallback)
      if (imgBuffer.length < 1000) {
        this.log(`Screenshot capture failed: thumbnail is empty (${imgBuffer.length} bytes) — permission may be missing`)
        return null
      }

      this.log(`Screen captured successfully (${imgBuffer.length} bytes)`)
    } catch (e: unknown) {
      this.log(`Screenshot capture failed: ${getErrorMessage(e)}`)
      return null
    }

    // Step 2: Get presigned POST data from backend
    try {
      const uploadUrlResp = await axios.get(`${this.apiUrl}/activities/screenshot-upload-url`, {
        params: { file_name: 'screenshot.jpg', content_type: 'image/jpeg' },
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: 8000
      })

      const { url: postUrl, fields } = uploadUrlResp.data
      if (!postUrl || !fields) {
        this.log('Screenshot upload failed: presigned POST response missing url/fields')
        return null
      }
      this.log(`Presigned URL generated: ${postUrl}, fields: ${Object.keys(fields).join(',')}`)

      // Step 3: POST file directly to S3 using native FormData + Blob (Node 18+, no external package)
      const form = new FormData()
      Object.entries(fields).forEach(([k, v]) => form.append(k, v as string))
      form.append('file', new Blob([imgBuffer], { type: 'image/jpeg' }), 'screenshot.jpg')

      const s3Resp = await axios.post(postUrl, form, {
        maxBodyLength: Infinity,
        timeout: 30000 // 30s — S3 uploads can be slower than API calls
      })

      if (![200, 204].includes(s3Resp.status)) {
        this.log(`Screenshot upload failed: S3 rejected with status ${s3Resp.status}`)
        return null
      }

      // Step 4: Return the S3 object key (not the full URL)
      const s3Key = fields['key'] as string
      this.log(`Screenshot uploaded to S3: ${s3Key}`)
      return s3Key

    } catch (e: unknown) {
      const axiosError = e as any
      if (axiosError?.response?.status === 503) {
        this.log('Screenshot skipped: S3 not configured on server')
      } else {
        const errorMsg = axiosError?.response?.data
          ? JSON.stringify(axiosError.response.data)
          : getErrorMessage(e)
        this.log(`Screenshot upload failed: ${errorMsg}`)
      }
      return null
    }
  }

  public async syncOfflineQueue() {
    if (!this.token || !this.apiUrl) return
    if (this.isSyncingQueue) return // Prevent duplicate concurrent sync execution

    try {
      this.isSyncingQueue = true
      
      let queue: any[] = []
      try {
        const content = await fs.readFile(this.queueFilePath, 'utf8')
        queue = JSON.parse(content)
        // Immediately clear the queue so new offline pulses can be appended safely without collision
        await fs.writeFile(this.queueFilePath, '[]')
      } catch (_) {
        return // File missing or empty
      }

      if (queue.length === 0) return
      this.log(`Syncing ${queue.length} offline pulses...`)
      
      const failedPulses: any[] = []
      for (const pulse of queue) {
        try {
          await axios.post(`${this.apiUrl}/activities/desktop-pulse`, pulse, {
            headers: { Authorization: `Bearer ${this.token}` },
            timeout: 8000 // Ensure it doesn't hang indefinitely
          })
        } catch (e) {
          failedPulses.push(pulse)
        }
      }

      // If any pulses failed during the sync, carefully merge them back into the disk file
      // to ensure pulses recorded during the sync aren't overwritten.
      if (failedPulses.length > 0) {
        try {
          let currentQ: any[] = []
          try {
            const currentContent = await fs.readFile(this.queueFilePath, 'utf8')
            currentQ = JSON.parse(currentContent)
          } catch (_) {}
          await fs.writeFile(this.queueFilePath, JSON.stringify([...failedPulses, ...currentQ]))
        } catch (err) { }
        this.log(`Partial sync completed, ${failedPulses.length} pulses restored to queue.`)
      } else {
        this.log('Offline queue fully synced.')
      }
    } finally {
      this.isSyncingQueue = false
    }
  }

  private async sendOrQueuePulse(payload: any, screenshotKey: string | null) {
    const pulseData = {
      ...payload,
      screenshot_url: screenshotKey
    }

    try {
      await axios.post(`${this.apiUrl}/activities/desktop-pulse`, pulseData, {
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: 10000 // Prevent a hanging request from locking isPulseRunning forever
      })
      this.log('Successfully sent pulse to backend.')

      // Since we are online, let's try to clear the queue if any exists
      this.syncOfflineQueue()
    } catch (e: any) {
      const status = e?.response?.status

      // CRITICAL: Only stop if the server explicitly tells us the session is DEAD (401/403/404)
      if ([401, 403, 404].includes(status)) {
        this.log(`Attendance session invalid (Status ${status}). Stopping engine.`)
        this.forceStop()
        BrowserWindow.getAllWindows().forEach(w => w.webContents.send('force-stop'))
        return
      }

      // Otherwise (timeout, 500, offline), just queue it — DO NOT STOP TRACKING
      this.log(`Pulse failed (${getErrorMessage(e)}), queueing offline. Tracking continues.`)
      try {
        let q: any[] = []
        try {
          const content = await fs.readFile(this.queueFilePath, 'utf8')
          q = JSON.parse(content)
        } catch (_) {}
        q.push(pulseData)
        await fs.writeFile(this.queueFilePath, JSON.stringify(q))
      } catch (err: unknown) {
        log.error('Could not write offline queue', getErrorMessage(err))
      }
    }
    // Note: isPulseRunning is released exclusively in runPulse's finally block
  }

  public destroy() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
    if (this.pulseInterval) clearInterval(this.pulseInterval)
  }
}
