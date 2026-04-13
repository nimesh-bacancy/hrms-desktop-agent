import { app, powerMonitor } from 'electron'
import { join } from 'path'
import { promises as fs, writeFileSync, appendFileSync } from 'fs'
import { activeWindow } from 'get-windows'
import screenshotDesktop from 'screenshot-desktop'
import axios from 'axios'
import log from 'electron-log'
// import ioHook from '@tkomde/iohook' // We will enable this cautiously

export class DesktopEngine {
  private queueFilePath: string
  private isTracking: boolean = false
  private attendanceId: number | null = null
  private isLocked: boolean = false
  private trackingStartTime: string | null = null
  private heartbeatInterval: NodeJS.Timeout | null = null
  private pulseInterval: NodeJS.Timeout | null = null
  
  // Tracking State
  private pulsesSinceScreenshot: number = 0
  private nextScreenshotThreshold: number = 3

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
        // Fire an immediate pulse to register the 'agent_start'
        this.runPulse('agent_start')
      }
    })

    // Pulse every 60 seconds
    this.pulseInterval = setInterval(() => this.runPulse(), 60000)
    
    this.log("Tracking engine started.")
  }

  public stopTracking() {
    if (!this.isTracking) return
    this.isTracking = false
    this.trackingStartTime = null
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval)
      this.pulseInterval = null
    }
    
    // Fire closing pulse and Clock Out
    this.runPulse('agent_stop').then(() => {
      this.triggerClockOut()
    })
    this.log("Tracking engine stopped and Clocked Out.")
  }

  // Called when backend says user is no longer clocked in
  public forceStop() {
    if (!this.isTracking) return
    this.isTracking = false
    this.trackingStartTime = null
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval)
      this.pulseInterval = null
    }
    this.attendanceId = null
    this.log("Tracking forcefully stopped because HRMS says user is clocked out.")
  }

  private async triggerClockIn(): Promise<boolean> {
    try {
      // First check if already clocked in to avoid 400 error
      const statusResp = await axios.get(`${this.apiUrl}/attendance/status`, {
        headers: { Authorization: `Bearer ${this.token}` }
      })
      if (statusResp.data && statusResp.data.is_clocked_in && statusResp.data.attendance_id) {
        this.attendanceId = statusResp.data.attendance_id
        this.log("Already Clocked In. Inheriting Attendance session.")
        return true
      }

      // If not clocked in, initiate it
      const resp = await axios.post(`${this.apiUrl}/attendance/clock-in`, {}, {
        headers: { Authorization: `Bearer ${this.token}` }
      })
      if (resp.data && resp.data.id) {
        this.attendanceId = resp.data.id
        this.log("Automatically Clocked In successfully.")
        return true
      }
      return false
    } catch (e) {
      this.log(`Failed to Clock In via agent: ${e.message}`)
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
        headers: { Authorization: `Bearer ${this.token}` }
      })
      this.log("Automatically Clocked Out successfully.")
      this.attendanceId = null
    } catch (e) {
      this.log(`Failed to Clock Out via agent: ${e.message}`)
    }
  }

  public setPowerState(isLocked: boolean) {
    this.isLocked = isLocked
    this.log(`Power state changed. Locked: ${isLocked}`)
    
    // Trigger an immediate pulse to update the server instantly
    if (this.isTracking) {
      this.runPulse(isLocked ? 'lock' : 'unlock')
    }
  }

  private async fetchAttendanceId(): Promise<boolean> {
    try {
      const resp = await axios.get(`${this.apiUrl}/attendance/status`, {
        headers: { Authorization: `Bearer ${this.token}` }
      })
      if (resp.data && resp.data.is_clocked_in && resp.data.attendance_id) {
        this.attendanceId = resp.data.attendance_id
        return true
      }
      this.attendanceId = null
      return false
    } catch (e) {
      this.log(`Failed to fetch attendance status: ${e.message}`)
      return false
    }
  }

  private getRandomScreenshotThreshold(): number {
    return Math.floor(Math.random() * 3) + 3 // Randomly yields 3, 4, or 5 minutes
  }

  private async runPulse(eventType: string | null = null) {
    try {
      // If token is missing (logged out), skip silently — don't forceStop
      if (!this.token) {
        this.log('Pulse skipped: no auth token (user logged out).')
        return
      }

      // Determine how to handle attendance ID based on event type
      if (eventType === 'heartbeat') {
        // For heartbeat: try to get attendance ID silently.
        // If not clocked in yet, just skip — don't forceStop.
        await this.fetchAttendanceId()
        if (!this.attendanceId) {
          this.log('Heartbeat skipped: user not yet clocked in.')
          return
        }
      } else if (eventType !== 'agent_start') {
        // For regular pulses: strict check — forceStop if not clocked in on server
        const ok = await this.fetchAttendanceId()
        if (!ok) {
          this.forceStop()
          const { BrowserWindow } = require('electron')
          BrowserWindow.getAllWindows().forEach(w => w.webContents.send('force-stop'))
          return
        }
      } else if (!this.attendanceId && eventType === 'agent_start') {
        // Fallback for startup
        const ok = await this.triggerClockIn()
        if (!ok) return
      }


      // Real idle detection via Electron's built-in powerMonitor
      // Returns seconds since last keyboard or mouse event — no native modules needed
      const idleTimeSeconds = powerMonitor.getSystemIdleTime()
      const activeWindowDetails = await activeWindow()

      // Screenshots: only for tracking pulses, not heartbeats
      let screenshotKey: string | null = null
      if (eventType !== 'heartbeat') {
        this.pulsesSinceScreenshot++
        if (eventType === 'agent_start' || this.pulsesSinceScreenshot >= this.nextScreenshotThreshold) {
          this.log(`Triggering screenshot... (eventType=${eventType})`)
          screenshotKey = await this.takeAndUploadScreenshot()
          this.pulsesSinceScreenshot = 0
          this.nextScreenshotThreshold = this.getRandomScreenshotThreshold()
        }
      }

      const payload = {
        attendance_id: this.attendanceId,
        is_active: !this.isLocked && idleTimeSeconds < 180, // 3 min idle threshold
        active_window: this.isLocked ? 'Locked' : (activeWindowDetails?.title || 'Unknown'),
        app_name: this.isLocked ? 'System' : (activeWindowDetails?.owner?.name || null),
        client_timestamp: new Date().toISOString(),
        event: eventType === 'heartbeat' ? null : eventType // backend expects agent_start/stop or null
      }

      this.log(`Sending pulse: event=${payload.event}, attendance=${payload.attendance_id}, active=${payload.is_active}`)

      // Queue or Send
      await this.sendOrQueuePulse(payload, screenshotKey)


    } catch (e) {
      this.log(`Pulse creation failed: ${e.message}`)
    }
  }

  private async takeAndUploadScreenshot(): Promise<string | null> {
    try {
      // Step 1: Capture screenshot as a Buffer
      const imgBuffer = await screenshotDesktop() as Buffer

      // Step 2: Get presigned POST data from backend
      const uploadUrlResp = await axios.get(`${this.apiUrl}/activities/screenshot-upload-url`, {
        params: { file_name: 'screenshot.jpg', content_type: 'image/jpeg' },
        headers: { Authorization: `Bearer ${this.token}` }
      })

      const { url: postUrl, fields } = uploadUrlResp.data
      if (!postUrl || !fields) {
        this.log('Presigned POST response missing url/fields')
        return null
      }
      this.log(`Presigned URL generated: ${postUrl}, fields: ${Object.keys(fields).join(',')}`)

      // Step 3: POST file directly to S3 using FormData
      const FormData = require('form-data')
      const form = new FormData()
      Object.entries(fields).forEach(([k, v]) => form.append(k, v))
      form.append('file', imgBuffer, { filename: 'screenshot.jpg', contentType: 'image/jpeg' })

      const s3Resp = await axios.post(postUrl, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity
      })

      if (![200, 204].includes(s3Resp.status)) {
        console.error('S3 upload rejected:', s3Resp.status)
        return null
      }

      // Step 4: Return the S3 object key (not the full URL)
      const s3Key = fields['key'] as string
      this.log(`Screenshot uploaded to S3: ${s3Key}`)
      return s3Key

    } catch (e: any) {
      if (e?.response?.status === 503) {
        this.log('Screenshot skipped: S3 not configured on server')
      } else {
        const errorMsg = e?.response?.data ? JSON.stringify(e.response.data) : (e?.message || String(e));
        this.log(`Screenshot upload failed: ${errorMsg}`)
      }
      return null
    }
  }

  public async syncOfflineQueue() {
    if (!this.token || !this.apiUrl) return
    
    try {
      const content = await fs.readFile(this.queueFilePath, 'utf8')
      const queue: any[] = JSON.parse(content)
      if (queue.length === 0) return

      this.log(`Syncing ${queue.length} offline pulses...`)
      
      const remaining: any[] = []
      for (const pulse of queue) {
        try {
          await axios.post(`${this.apiUrl}/activities/desktop-pulse`, pulse, {
            headers: { Authorization: `Bearer ${this.token}` }
          })
        } catch (e) {
          remaining.push(pulse)
        }
      }

      await fs.writeFile(this.queueFilePath, JSON.stringify(remaining))
      if (remaining.length === 0) {
        this.log('Offline queue fully synced.')
      } else {
        this.log(`Partial sync completed, ${remaining.length} pulses still queued.`)
      }
    } catch (err) {
      // File missing or corrupt, treat as empty
    }
  }

  private async sendOrQueuePulse(payload: any, screenshotKey: string | null) {
    const pulseData = {
      ...payload,
      screenshot_url: screenshotKey
    }

    try {
      await axios.post(`${this.apiUrl}/activities/desktop-pulse`, pulseData, {
        headers: { Authorization: `Bearer ${this.token}` }
      })
      this.log('Successfully sent pulse to backend.')
      
      // Since we are online, let's try to clear the queue if any exists
      this.syncOfflineQueue()
    } catch (e) {
      this.log('API failed, queueing offline pulse.')
      try {
        let q: any[] = []
        try {
          const content = await fs.readFile(this.queueFilePath, 'utf8')
          q = JSON.parse(content)
        } catch (_) {}
        q.push(pulseData)
        await fs.writeFile(this.queueFilePath, JSON.stringify(q))
      } catch (err) {
        log.error('Could not write offline queue', err)
      }
    }
  }

  public destroy() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
    if (this.pulseInterval) clearInterval(this.pulseInterval)
  }
}
