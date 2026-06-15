import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, Square, LogOut, Clock, Coffee, Zap, Monitor, Maximize2, Minimize2 } from 'lucide-react'
import Login from './components/Login'
import { LogoIcon } from './components/LogoIcon'
import axios from 'axios'

// ─── Types ────────────────────────────────────────────────────────────────────
interface UserProfile {
  id: number
  full_name: string
  email: string
  profile_picture?: string | null
  role?: string
  timezone?: string
}

interface DayStats {
  today_total_hours: number
  today_break_hours: number
  is_clocked_in: boolean
  last_clock_in?: string | null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const formatDuration = (totalSeconds: number): string => {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const formatHours = (hours: number): string => {
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
const Dashboard = ({ onLogout, apiUrl, token, tenantId }: { onLogout: () => void; apiUrl: string; token: string; tenantId: number | null }) => {
  const [isActive, setIsActive] = useState(false)
  const [isOnBreak, setIsOnBreak] = useState(false)
  const [sessionSeconds, setSessionSeconds] = useState(0)
  const [idleSeconds, setIdleSeconds] = useState(0)
  const [activeSeconds, setActiveSeconds] = useState(0)
  const [user, setUser] = useState<UserProfile | null>(null)
  const [, setDayStats] = useState<DayStats | null>(null)
  const [currentApp, setCurrentApp] = useState<string>('—')
  const [showIdlePrompt, setShowIdlePrompt] = useState(false)
  const [launchAtStartup, setLaunchAtStartup] = useState(false)
  const [appVersion, setAppVersion] = useState<string>('')
  const [isMini, setIsMini] = useState(false)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null)   // version string
  const [updateProgress, setUpdateProgress] = useState<number | null>(null)     // 0-100
  const [updateReady, setUpdateReady] = useState<string | null>(null)           // version string
  const [updateBanner, setUpdateBanner] = useState<string | null>(null)
  const [versionBlocked, setVersionBlocked] = useState<string | null>(null)    // minimum version required
  const [clockOutError, setClockOutError] = useState<string | null>(null)
  const [screenshotFlash, setScreenshotFlash] = useState(false)
  const [sessionExpired, setSessionExpired] = useState(false)

  useEffect(() => {
    // @ts-ignore
    window.api.getLaunchAtStartup().then(setLaunchAtStartup)
  }, [])

  useEffect(() => {
    window.electron.ipcRenderer.invoke('get-app-version').then(async (v: string) => {
      setAppVersion(v)
      try {
        const resp = await axios.get(`${apiUrl}/system/agent-release/latest`, { headers: authHeaders })
        const data = resp.data

        const toNum = (s: string) => s.replace(/[^0-9.]/g, '').split('.').map(Number)
        const isOlderThan = (cur: string, ref: string) => {
          const c = toNum(cur), r = toNum(ref)
          for (let i = 0; i < Math.max(c.length, r.length); i++) {
            if ((c[i] ?? 0) < (r[i] ?? 0)) return true
            if ((c[i] ?? 0) > (r[i] ?? 0)) return false
          }
          return false
        }

        // Hard block: agent is below the minimum required version
        const minVer: string = data?.minimum_version || '1.0.0'
        if (isOlderThan(v, minVer)) {
          setVersionBlocked(minVer)
          return
        }

        // Soft banner: newer version available (only shown on Linux deb/snap where auto-update skips)
        const osKey = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
        const latest: string = data?.[osKey]?.version
        if (latest && isOlderThan(v, latest)) {
          setUpdateBanner(`Update available: v${latest} — download from the Downloads page`)
        }
      } catch (_) {
        // Version check is non-critical — ignore errors
      }
    })
  }, [])

  // Clock-out failed notification from engine
  useEffect(() => {
    const handler = (_: any, msg: string) =>
      setClockOutError(msg || 'Clock-out failed. Please clock out manually.')
    window.electron?.ipcRenderer?.on('clock-out-failed', handler)
    return () => { window.electron?.ipcRenderer?.removeListener('clock-out-failed', handler) }
  }, [])

  // Session expired — show banner then auto-logout after 5s
  useEffect(() => {
    const handler = () => {
      setSessionExpired(true)
      setTimeout(() => onLogout(), 5000)
    }
    window.electron?.ipcRenderer?.on('session-expired', handler)
    return () => { window.electron?.ipcRenderer?.removeListener('session-expired', handler) }
  }, [onLogout])

  // Screenshot-taken notification
  useEffect(() => {
    const handler = () => {
      setScreenshotFlash(true)
      setTimeout(() => setScreenshotFlash(false), 3000)
    }
    window.electron?.ipcRenderer?.on('screenshot-taken', handler)
    return () => { window.electron?.ipcRenderer?.removeListener('screenshot-taken', handler) }
  }, [])

  // Midnight rollover — engine started a new day session, reset UI counters to 0
  // (new day = genuinely zero active/idle accumulated so far)
  useEffect(() => {
    const handler = () => {
      setSessionSeconds(0)
      setActiveSeconds(0)
      setIdleSeconds(0)
      setIsOnBreak(false)
    }
    window.electron?.ipcRenderer?.on('day-rolled-over', handler)
    return () => { window.electron?.ipcRenderer?.removeListener('day-rolled-over', handler) }
  }, [])

  // Auto-update IPC listeners
  useEffect(() => {
    const onAvailable = (_: any, version: string) => { setUpdateAvailable(version); setUpdateProgress(0) }
    const onProgress  = (_: any, pct: number)     => setUpdateProgress(pct)
    const onReady     = (_: any, version: string) => { setUpdateReady(version); setUpdateProgress(null) }
    window.electron?.ipcRenderer?.on('update-available',        onAvailable)
    window.electron?.ipcRenderer?.on('update-download-progress', onProgress)
    window.electron?.ipcRenderer?.on('update-downloaded',       onReady)
    return () => {
      window.electron?.ipcRenderer?.removeListener('update-available',         onAvailable)
      window.electron?.ipcRenderer?.removeListener('update-download-progress', onProgress)
      window.electron?.ipcRenderer?.removeListener('update-downloaded',        onReady)
    }
  }, [])

  // Live active-window feed from engine
  useEffect(() => {
    const handler = (_: any, title: string) => setCurrentApp(title || '—')
    window.electron.ipcRenderer.on('active-window-update', handler)
    return () => { window.electron.ipcRenderer.removeListener('active-window-update', handler) }
  }, [])

  // Seed idle/active counters from today's server-side productivity data.
  // Call this whenever tracking starts/restarts so the widget always shows
  // the FULL DAY totals, not just the time since the last app open.
  const seedActivityCounters = async () => {
    try {
      const today = new Date().toISOString().slice(0, 10)
      const resp = await axios.get(`${apiUrl}/activities/summary`, {
        headers: authHeaders,
        params: { start_date: today, end_date: today },
      })
      const rec = resp.data?.[0]
      if (rec) {
        setActiveSeconds(Math.round(rec.total_active_seconds || 0))
        setIdleSeconds(Math.round(rec.total_idle_seconds || 0))
      }
    } catch (_) {
      // Non-critical — counters will just accumulate from current value
    }
  }

  const handleToggleStartup = (val: boolean) => {
    setLaunchAtStartup(val)
    // @ts-ignore
    window.api.setLaunchAtStartup(val)
  }
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const promptFiredRef = useRef<boolean>(false)
  const [autoClockInNotice, setAutoClockInNotice] = useState(false)

  // Mouse/keyboard activity tracking — sent to engine every 60s for intensity data
  const mouseMovementRef = useRef<number>(0)
  const activityFlushCountRef = useRef<number>(0)
  useEffect(() => {
    const onMouseMove = () => { mouseMovementRef.current += 1 }
    const onKeyDown  = () => { mouseMovementRef.current += 2 } // keyboard weighted 2x
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    ...(tenantId ? { 'X-Tenant-ID': String(tenantId) } : {}),
  }

  // Sync offline queue when coming back online
  useEffect(() => {
    const handleOffline = () => {
      console.log('App went offline, queuing pulses locally...')
      setIsReconnecting(true)
    }
    const handleOnline = () => {
      console.log('App back online, triggering sync...')
      window.electron.ipcRenderer.send('trigger-sync')
      // Clear the banner once sync completes (give the engine ~3s to flush)
      setTimeout(() => setIsReconnecting(false), 3000)
    }
    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)
    return () => {
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
    }
  }, [])

  // Global Axios Interceptor — smart 401 handling
  // Background tracking endpoints (pulse, attendance) → engine handles, no logout
  // Identity endpoints (users/me) → token genuinely expired → logout
  useEffect(() => {
    // Track consecutive 401s on identity calls to avoid false-positives from glitches
    let consecutiveIdentity401s = 0

    const BACKGROUND_ENDPOINTS = [
      '/activities/desktop-pulse',
      '/activities/agent-config',
      '/activities/screenshot-upload-url',
      '/attendance/status',
      '/attendance/heartbeat',
      '/attendance/clock-in',
      '/attendance/clock-out',
      '/system/',
    ]

    const interceptor = axios.interceptors.response.use(
      (response) => {
        consecutiveIdentity401s = 0 // reset on any success
        return response
      },
      (error) => {
        const url: string = error.config?.url || ''
        const status: number = error.response?.status

        if (status === 401) {
          const isBackground = BACKGROUND_ENDPOINTS.some(ep => url.includes(ep))

          if (isBackground) {
            // Engine handles these — do not logout
            return Promise.reject(error)
          }

          // Identity call (users/me, etc.) — token genuinely expired
          // Require 2 consecutive failures to avoid glitch-logout
          consecutiveIdentity401s++
          if (consecutiveIdentity401s >= 2) {
            console.warn('Token expired (confirmed). Logging out.')
            consecutiveIdentity401s = 0
            setSessionExpired(true)
            setTimeout(() => onLogout(), 5000)
          }
        }

        return Promise.reject(error)
      }
    )
    return () => axios.interceptors.response.eject(interceptor)
  }, [onLogout])

  // Fetch user profile and daily stats on mount
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [usersResp, statusResp] = await Promise.all([
          axios.get(`${apiUrl}/users/me`, { headers: authHeaders }),
          axios.get(`${apiUrl}/attendance/status`, { headers: authHeaders })
        ])
        setUser(usersResp.data)
        if (usersResp.data?.timezone) {
          setTimezone(usersResp.data.timezone)
          localStorage.setItem('wp_user_timezone', usersResp.data.timezone)
        }
        setDayStats(statusResp.data)
        
        // Sync with background engine status
        // @ts-ignore
        const engineStatus = await window.electron.ipcRenderer.invoke('get-engine-status')

        // Helper: seed session timer to match the web ClockControl formula exactly.
        // Formula: completed sessions (today_total_hours) + net elapsed in current session.
        // Net elapsed = gross elapsed since clock-in minus any break time already accumulated
        // (today_break_hours covers completed breaks; ongoing break subtracted separately).
        const seedSessionFromStatus = (s: typeof statusResp.data) => {
          const completedSec = Math.round((s.today_total_hours || 0) * 3600)
          const breakSec = Math.round((s.today_break_hours || 0) * 3600)
          if (s.last_clock_in) {
            const clockInStart = new Date(s.last_clock_in).getTime()
            const grossSec = Math.max(0, Math.floor((Date.now() - clockInStart) / 1000))
            // Subtract ongoing break duration if currently on break
            const ongoingBreakSec = (s.is_on_break && s.last_break_start)
              ? Math.max(0, Math.floor((Date.now() - new Date(s.last_break_start).getTime()) / 1000))
              : 0
            setSessionSeconds(completedSec + Math.max(0, grossSec - breakSec - ongoingBreakSec))
          } else {
            setSessionSeconds(completedSec)
          }
          const onBreak = !!s.is_on_break
          setIsOnBreak(onBreak)
          window.electron.ipcRenderer.send('set-break-state', onBreak)
        }

        if (engineStatus && engineStatus.isTracking) {
          setIsActive(true)
          seedSessionFromStatus(statusResp.data)
          seedActivityCounters()
        } else if (statusResp.data.is_clocked_in && statusResp.data.last_clock_in) {
          setIsActive(true)
          seedSessionFromStatus(statusResp.data)
          seedActivityCounters()
        }
      } catch (e) {
        console.error('Failed to fetch user data', e)
      }
    }
    fetchData()
  }, [])

  // Localized Real-time Clock — seeded from localStorage so the correct tz shows immediately on mount
  const [currentTime, setCurrentTime] = useState(new Date())
  const [timezone, setTimezone] = useState<string>(
    () => localStorage.getItem('wp_user_timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone
  )

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Native Window Resizing for Mini-Mode
  useEffect(() => {
    // @ts-ignore
    if (window.api?.toggleMini) {
      // @ts-ignore
      window.api.toggleMini(isMini)
    }
  }, [isMini])

  // Force-stop listener from backend (remote clock-out)
  useEffect(() => {
    const stopListener = () => setIsActive(false)
    if (window.electron?.ipcRenderer) {
      window.electron.ipcRenderer.on('force-stop', stopListener)
    }
    return () => {
      window.electron?.ipcRenderer?.removeListener('force-stop', stopListener)
    }
  }, [])

  // Session timer + idle/active splitter
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current)

    if (isActive) {
      window.electron.ipcRenderer.send('start-tracking')
      timerRef.current = setInterval(async () => {
        // Don't advance session timer while on break
        setSessionSeconds(s => isOnBreak ? s : s + 1)

        // Every 60s: flush accumulated mouse/keyboard activity count to engine
        // Uses a counter mod 60 so we stay aligned with the engine's 60s pulse
        activityFlushCountRef.current = (activityFlushCountRef.current ?? 0) + 1
        if (!isOnBreak && activityFlushCountRef.current >= 60) {
          activityFlushCountRef.current = 0
          const count = mouseMovementRef.current
          mouseMovementRef.current = 0
          window.electron.ipcRenderer.send('report-activity', { mouseMovement: count })
        }

        // Skip idle detection entirely while on break — user is intentionally away
        if (isOnBreak) return

        try {
          // Fetch exact OS idle seconds directly via IPC
          const systemIdle: number = await window.electron.ipcRenderer.invoke('get-idle-time')

          const IDLE_PROMPT_THRESHOLD = 180 // 3 minutes

          const currentlyIdle = systemIdle >= IDLE_PROMPT_THRESHOLD

          if (currentlyIdle && !promptFiredRef.current) {
            promptFiredRef.current = true
            window.electron.ipcRenderer.send('force-focus')
          } else if (!currentlyIdle) {
            promptFiredRef.current = false
          }

          setShowIdlePrompt(currentlyIdle)
          setActiveSeconds(a => currentlyIdle ? a : a + 1)
          setIdleSeconds(i => currentlyIdle ? i + 1 : i)
        } catch (e: any) {
          setActiveSeconds(a => a + 1)
        }
      }, 1000)
    } else {
      window.electron.ipcRenderer.send('stop-tracking')
      setTimeout(async () => {
        try {
          const resp = await axios.get(`${apiUrl}/attendance/status`, { headers: authHeaders })
          setDayStats(resp.data)
        } catch (_) {}
      }, 1500)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [isActive, isOnBreak])


  // Periodic stats refresh — re-syncs session timer and activity counters with backend every 60s
  useEffect(() => {
    if (!isActive) return
    const headers = authHeaders
    const refresh = setInterval(async () => {
      try {
        const resp = await axios.get(`${apiUrl}/attendance/status`, { headers })
        setDayStats(resp.data)
        if (!resp.data.is_clocked_in) {
          setIsActive(false)
          setIsOnBreak(false)
        } else if (resp.data.last_clock_in) {
          setIsOnBreak(!!resp.data.is_on_break)
          const completedSec = Math.round((resp.data.today_total_hours || 0) * 3600)
          const breakSec = Math.round((resp.data.today_break_hours || 0) * 3600)
          const start = new Date(resp.data.last_clock_in).getTime()
          const grossSec = Math.max(0, Math.floor((Date.now() - start) / 1000))
          const ongoingBreakSec = (resp.data.is_on_break && resp.data.last_break_start)
            ? Math.max(0, Math.floor((Date.now() - new Date(resp.data.last_break_start).getTime()) / 1000))
            : 0
          setSessionSeconds(completedSec + Math.max(0, grossSec - breakSec - ongoingBreakSec))
        }
        // Re-sync active/idle counters from DB every 60s so widget stays accurate
        await seedActivityCounters()
      } catch (_) {}
    }, 60000)
    return () => clearInterval(refresh)
  }, [isActive, apiUrl, token])

  const workGoalSeconds = 8 * 3600
  // Use live sessionSeconds for progress so the bar advances in real-time
  const progressPct = Math.min(100, (sessionSeconds / workGoalSeconds) * 100)
  const sessionIdlePct = sessionSeconds > 0 ? Math.round((idleSeconds / sessionSeconds) * 100) : 0
  const sessionActivePct = 100 - sessionIdlePct

  const initials = user?.full_name?.split(' ').map(n => n[0]).join('').toUpperCase() || 'U'

  return (
    <div className="root-layout" style={{ 
      background: 'radial-gradient(circle at top left, #0f172a 0%, #03050a 100%)',
      height: '100vh', display: 'flex', overflow: 'hidden' 
    }}>
      <AnimatePresence mode="wait">
        {isMini ? (
          /* MINI MODE VIEW */
          <motion.div 
            key="mini"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            style={{ 
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', 
              padding: '24px' 
            }}
          >
            <div className="glass-card" style={{ 
              padding: '16px 24px', display: 'flex', alignItems: 'center', gap: '20px',
              minWidth: '320px', justifyContent: 'space-between'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <LogoIcon size={24} />
                <div>
                   <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--wp-text-mute)', textTransform: 'uppercase' }}>Session</div>
                   <div style={{ fontSize: '1.2rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{formatDuration(sessionSeconds)}</div>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <motion.button 
                  whileTap={{ scale: 0.9 }}
                  onClick={() => setIsActive(!isActive)}
                  style={{ 
                    width: '36px', height: '36px', borderRadius: '10px', 
                    background: isActive ? 'var(--wp-danger)' : 'var(--wp-success)',
                    border: 'none', color: 'white', cursor: 'pointer', display: 'flex', 
                    alignItems: 'center', justifyContent: 'center'
                  }}
                >
                  {isActive ? <Square size={16} fill="white" /> : <Play size={16} fill="white" />}
                </motion.button>
                <button 
                  onClick={() => setIsMini(false)}
                  style={{ background: 'none', border: 'none', color: 'var(--wp-text-mute)', cursor: 'pointer' }}
                >
                  <Maximize2 size={18} />
                </button>
              </div>
            </div>
          </motion.div>
        ) : (
          /* FULL MODE VIEW (Original Sidebar + Content) */
          <motion.div 
            key="full"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ display: 'flex', flex: 1, width: '100%' }}
          >
            {/* Sidebar - Native Feel */}
            <motion.div 
              initial={{ x: -80 }} animate={{ x: 0 }}
              style={{ 
                width: '72px', borderRight: '1px solid var(--glass-border)', 
                background: 'rgba(15, 23, 42, 0.4)', display: 'flex', flexDirection: 'column', 
                alignItems: 'center', padding: '24px 0', gap: '32px' 
              }}
            >
              <LogoIcon size={32} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <motion.button whileHover={{ scale: 1.1 }} style={{ background: 'none', border: 'none', color: 'var(--wp-accent)', cursor: 'pointer' }}>
                   <Clock size={22} />
                </motion.button>
                <motion.button whileHover={{ scale: 1.1 }} style={{ background: 'none', border: 'none', color: 'var(--wp-text-mute)', cursor: 'pointer' }}>
                   <Monitor size={22} />
                </motion.button>
                <motion.button 
                  whileHover={{ scale: 1.1 }} 
                  onClick={() => setIsMini(true)}
                  style={{ background: 'none', border: 'none', color: 'var(--wp-text-mute)', cursor: 'pointer' }}
                >
                   <Minimize2 size={22} />
                </motion.button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'center', paddingBottom: '12px' }}>
                 <button onClick={onLogout} style={{ background: 'none', border: 'none', color: 'var(--wp-danger)', cursor: 'pointer' }}>
                    <LogOut size={22} />
                 </button>
              </div>
            </motion.div>

            {/* Main Content */}
            <div style={{ flex: 1, position: 'relative', overflowY: 'auto', padding: '32px 40px' }}>

        {/* Hard-block: agent version too old — must update before using */}
        <AnimatePresence>
          {versionBlocked && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              style={{
                position: 'fixed', inset: 0, zIndex: 9999,
                background: 'rgba(3,5,10,0.92)', backdropFilter: 'blur(12px)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <motion.div
                initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }}
                className="glass-card"
                style={{ padding: '48px', maxWidth: '420px', textAlign: 'center' }}
              >
                <div style={{ fontSize: '3rem', marginBottom: '16px' }}>⚠️</div>
                <h2 style={{ fontSize: '1.4rem', fontWeight: 800, marginBottom: '12px', color: 'var(--wp-danger)' }}>
                  Update Required
                </h2>
                <p style={{ color: 'var(--wp-text-mute)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '8px' }}>
                  This version of WorkPulse HR is no longer supported.
                </p>
                <p style={{ color: 'var(--wp-text-mute)', fontSize: '0.9rem', marginBottom: '32px' }}>
                  Minimum required version: <strong style={{ color: '#fff' }}>v{versionBlocked}</strong>
                </p>
                <p style={{ color: 'var(--wp-text-mute)', fontSize: '0.8rem' }}>
                  Please download the latest version from your admin's Downloads page and reinstall.
                </p>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Reconnecting Banner */}
        <AnimatePresence>
          {isReconnecting && (
            <motion.div
              initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}
              style={{
                position: 'sticky', top: 0, zIndex: 50, marginBottom: '16px',
                background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.4)',
                borderRadius: '10px', padding: '10px 16px',
                display: 'flex', alignItems: 'center', gap: '10px', backdropFilter: 'blur(8px)',
              }}
            >
              <span style={{ fontSize: '1rem' }}>&#x26A1;</span>
              <span style={{ color: 'var(--wp-warning)', fontWeight: 600, fontSize: '0.85rem' }}>
                Offline — pulses queued locally, will sync when reconnected
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Update Ready — "Restart to Install" (highest priority) */}
        <AnimatePresence>
          {updateReady && (
            <motion.div
              initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}
              style={{
                position: 'sticky', top: 0, zIndex: 50, marginBottom: '16px',
                background: 'rgba(16, 185, 129, 0.12)', border: '1px solid rgba(16,185,129,0.5)',
                borderRadius: '10px', padding: '10px 16px',
                display: 'flex', alignItems: 'center', gap: '12px', backdropFilter: 'blur(8px)',
              }}
            >
              <span style={{ fontSize: '1rem' }}>🚀</span>
              <span style={{ color: 'var(--wp-success)', fontWeight: 600, fontSize: '0.85rem', flex: 1 }}>
                v{updateReady} is ready — restart to install the update.
              </span>
              <button
                onClick={() => window.electron.ipcRenderer.send('install-update')}
                style={{
                  padding: '6px 16px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                  background: 'var(--wp-success)', color: '#fff', fontWeight: 700, fontSize: '0.8rem',
                }}
              >
                Restart Now
              </button>
              <button
                onClick={() => setUpdateReady(null)}
                style={{ background: 'none', border: 'none', color: 'var(--wp-text-mute)', cursor: 'pointer', fontSize: '1rem' }}
              >
                &#x2715;
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Update Downloading — progress bar */}
        <AnimatePresence>
          {updateAvailable && updateProgress !== null && !updateReady && (
            <motion.div
              initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}
              style={{
                position: 'sticky', top: 0, zIndex: 50, marginBottom: '16px',
                background: 'rgba(245, 158, 11, 0.10)', border: '1px solid rgba(245,158,11,0.4)',
                borderRadius: '10px', padding: '10px 16px', backdropFilter: 'blur(8px)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                <span style={{ fontSize: '1rem' }}>⬇️</span>
                <span style={{ color: 'var(--wp-warning)', fontWeight: 600, fontSize: '0.85rem', flex: 1 }}>
                  Downloading v{updateAvailable}… {updateProgress}%
                </span>
              </div>
              <div style={{ width: '100%', height: '4px', background: 'rgba(255,255,255,0.08)', borderRadius: '2px' }}>
                <motion.div
                  animate={{ width: `${updateProgress}%` }}
                  style={{ height: '100%', background: 'var(--wp-warning)', borderRadius: '2px' }}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Fallback: manual download banner (shown when updater not supported, e.g. Linux deb) */}
        <AnimatePresence>
          {updateBanner && !updateAvailable && !updateReady && (
            <motion.div
              initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}
              style={{
                position: 'sticky', top: 0, zIndex: 50, marginBottom: '16px',
                background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.4)',
                borderRadius: '10px', padding: '10px 16px',
                display: 'flex', alignItems: 'center', gap: '10px', backdropFilter: 'blur(8px)',
              }}
            >
              <span style={{ color: 'var(--wp-warning)', fontWeight: 600, fontSize: '0.85rem', flex: 1 }}>
                {updateBanner}
              </span>
              <button
                onClick={() => setUpdateBanner(null)}
                style={{ background: 'none', border: 'none', color: 'var(--wp-text-mute)', cursor: 'pointer', fontSize: '1rem' }}
              >
                &#x2715;
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Clock-Out Failed Error Banner */}
        <AnimatePresence>
          {sessionExpired && (
            <motion.div
              key="session-expired"
              initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}
              style={{
                position: 'sticky', top: 0, zIndex: 50, marginBottom: '16px',
                background: 'rgba(239, 68, 68, 0.18)', border: '1px solid rgba(239, 68, 68, 0.6)',
                borderRadius: '10px', padding: '10px 16px',
                display: 'flex', alignItems: 'center', gap: '10px', backdropFilter: 'blur(8px)',
              }}
            >
              <span style={{ fontSize: '1rem' }}>⚠️</span>
              <span style={{ color: '#ef4444', fontWeight: 700, fontSize: '0.85rem', flex: 1 }}>
                Your session has expired. Redirecting to login in 5 seconds...
              </span>
            </motion.div>
          )}

          {clockOutError && (
            <motion.div
              initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}
              style={{
                position: 'sticky', top: 0, zIndex: 50, marginBottom: '16px',
                background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.4)',
                borderRadius: '10px', padding: '10px 16px',
                display: 'flex', alignItems: 'center', gap: '10px', backdropFilter: 'blur(8px)',
              }}
            >
              <span style={{ color: 'var(--wp-danger)', fontWeight: 600, fontSize: '0.85rem', flex: 1 }}>
                {clockOutError}
              </span>
              <button
                onClick={() => setClockOutError(null)}
                style={{ background: 'none', border: 'none', color: 'var(--wp-text-mute)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}
              >
                &#x2715;
              </button>
            </motion.div>
          )}

          {screenshotFlash && (
            <motion.div
              key="screenshot-flash"
              initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }}
              style={{
                position: 'sticky', top: 0, zIndex: 50, marginBottom: '16px',
                background: 'rgba(99, 102, 241, 0.12)', border: '1px solid rgba(99, 102, 241, 0.4)',
                borderRadius: '10px', padding: '10px 16px',
                display: 'flex', alignItems: 'center', gap: '10px', backdropFilter: 'blur(8px)',
              }}
            >
              <span style={{ fontSize: '1rem' }}>📸</span>
              <span style={{ color: 'var(--wp-accent)', fontWeight: 600, fontSize: '0.85rem', flex: 1 }}>
                Screenshot captured by your administrator.
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Header Area */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px' }}>
          <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }}>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: 0, letterSpacing: '-0.5px' }}>
              Hello, {user?.full_name?.split(' ')[0] || 'User'}
            </h1>
            <p style={{ color: 'var(--wp-text-mute)', fontSize: '0.85rem', margin: '4px 0 0 0', display: 'flex', alignItems: 'center', gap: '8px' }}>
               <span style={{ color: 'var(--wp-accent)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                 {currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: timezone })}
               </span>
               <span style={{ fontSize: '0.7rem', opacity: 0.8 }}>({timezone})</span>
               <span style={{ opacity: 0.3 }}>•</span>
               <span>{currentTime.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: timezone })}</span>
               <span style={{ opacity: 0.3 }}>•</span>
               <span style={{ fontSize: '0.7rem', color: 'var(--wp-success)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: 'currentColor' }} />
                  Connected
               </span>
               {appVersion && (
                 <>
                   <span style={{ opacity: 0.3 }}>•</span>
                   <span style={{ fontSize: '0.7rem', color: 'var(--wp-text-mute)', fontWeight: 600 }}>v{appVersion}</span>
                 </>
               )}
            </p>
          </motion.div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
             <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>{user?.role || 'Team Member'}</div>
             </div>
              <div 
                onClick={() => handleToggleStartup(!launchAtStartup)}
                style={{ 
                  display: 'flex', alignItems: 'center', gap: '8px', 
                  cursor: 'pointer', padding: '6px 10px', borderRadius: '20px',
                  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)'
                }}
                title="Launch app on system startup"
              >
                <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--wp-text-mute)', textTransform: 'uppercase' }}>Autostart</div>
                <div style={{ 
                  width: '32px', height: '18px', borderRadius: '10px',
                  background: launchAtStartup ? 'var(--wp-accent)' : 'rgba(255,255,255,0.1)',
                  position: 'relative', transition: 'all 0.3s ease'
                }}>
                  <div style={{ 
                    position: 'absolute', top: '2px', left: launchAtStartup ? '16px' : '2px',
                    width: '14px', height: '14px', borderRadius: '50%', background: '#fff',
                    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
                  }} />
                </div>
              </div>

              <div style={{ 
                width: '40px', height: '40px', borderRadius: '12px', 
                background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700
              }}>
                {initials}
              </div>
          </div>
        </div>

        {/* Hero Section - Timer */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '24px', marginBottom: '24px' }}>
          <motion.div 
            layout 
            className="glass-card" 
            style={{ 
              padding: '40px', display: 'flex', flexDirection: 'column', 
              alignItems: 'center', justifyContent: 'center', gap: '24px',
              border: isActive ? '1px solid rgba(16, 185, 129, 0.2)' : '1px solid var(--glass-border)'
            }}
          >
            <div style={{ textAlign: 'center' }}>
               <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--wp-text-mute)', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: '8px' }}>
                 Current Session
               </div>
               <div className="wp-timer-hero">
                 {formatDuration(sessionSeconds)}
               </div>
            </div>

            <AnimatePresence>
              {isActive && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
                  className="wp-badge"
                  style={{
                    backgroundColor: isOnBreak ? 'rgba(99,102,241,0.15)' : showIdlePrompt ? 'rgba(245,158,11,0.15)' : 'rgba(16, 185, 129, 0.15)',
                    color: isOnBreak ? '#818cf8' : showIdlePrompt ? 'var(--wp-warning)' : 'var(--wp-success)'
                  }}
                >
                  <span style={{
                    width: '6px', height: '6px', borderRadius: '50%',
                    backgroundColor: 'currentColor', display: 'inline-block',
                    marginRight: '8px', boxShadow: '0 0 8px currentColor'
                  }} />
                  {isOnBreak ? 'On Break' : showIdlePrompt ? 'System Idle' : 'Tracking Active'}
                </motion.div>
              )}
            </AnimatePresence>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center' }}>
              <motion.button
                whileTap={{ scale: 0.95 }}
                onClick={() => setIsActive(!isActive)}
                className={`wp-button ${isActive ? 'wp-button-danger' : 'wp-button-primary'}`}
                style={{ padding: '16px 48px', minWidth: '240px' }}
              >
                {isActive ? <Square size={20} fill="white" /> : <Play size={20} fill="white" />}
                {isActive ? 'Clock Out Now' : 'Start Tracking'}
              </motion.button>

              {isActive && (
                <motion.button
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={async () => {
                    try {
                      if (isOnBreak) {
                        await axios.post(`${apiUrl}/attendance/break-end`, {}, { headers: authHeaders })
                        setIsOnBreak(false)
                        window.electron.ipcRenderer.send('set-break-state', false)
                      } else {
                        await axios.post(`${apiUrl}/attendance/break-start`, {}, { headers: authHeaders })
                        setIsOnBreak(true)
                        window.electron.ipcRenderer.send('set-break-state', true)
                      }
                    } catch (e: any) {
                      console.error('Break toggle failed', e)
                    }
                  }}
                  style={{
                    padding: '10px 32px', minWidth: '240px', borderRadius: '12px',
                    background: isOnBreak ? 'rgba(16,185,129,0.15)' : 'rgba(99,102,241,0.15)',
                    border: `1px solid ${isOnBreak ? 'var(--wp-success)' : 'rgba(99,102,241,0.4)'}`,
                    color: isOnBreak ? 'var(--wp-success)' : '#818cf8',
                    fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
                  }}
                >
                  <Coffee size={16} />
                  {isOnBreak ? 'End Break' : 'Take a Break'}
                </motion.button>
              )}
            </div>
          </motion.div>

          {/* Right Column - Goal & Session Metrics */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div className="glass-card" style={{ padding: '24px' }}>
               <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '16px' }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Daily Progress</span>
                  <span style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--wp-accent)' }}>{Math.round(progressPct)}%</span>
               </div>
               <div style={{ width: '100%', height: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px', overflow: 'hidden', marginBottom: '12px' }}>
                  <motion.div 
                    initial={{ width: 0 }} animate={{ width: `${progressPct}%` }}
                    style={{ height: '100%', background: 'linear-gradient(90deg, #3b82f6, #8b5cf6)', borderRadius: '4px' }} 
                  />
               </div>
               <p style={{ fontSize: '0.75rem', color: 'var(--wp-text-mute)', margin: 0 }}>
                  {formatHours(sessionSeconds / 3600)} of 8h Goal
               </p>
            </div>

            <div className="glass-card" style={{ padding: '24px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
               <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                  <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: 'rgba(59, 130, 246, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                     <Zap size={20} color="var(--wp-accent)" />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--wp-text-mute)' }}>Productivity Score</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 800, color: sessionActivePct >= 70 ? 'var(--wp-success)' : sessionActivePct >= 40 ? 'var(--wp-warning)' : 'var(--wp-danger)' }}>
                      {sessionActivePct}%
                    </div>
                  </div>
               </div>
               {/* Active vs Idle bar */}
               <div style={{ display: 'flex', height: '6px', gap: '2px', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{ flex: sessionActivePct, background: 'var(--wp-success)', transition: 'flex 1s' }} />
                  <div style={{ flex: sessionIdlePct, background: 'rgba(245,158,11,0.4)', transition: 'flex 1s' }} />
               </div>
               <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '6px', fontSize: '0.7rem', color: 'var(--wp-text-mute)' }}>
                  <span>🟢 {sessionActivePct}% active</span>
                  <span>🟡 {sessionIdlePct}% idle</span>
               </div>
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '24px' }}>
          {[
            { label: 'Today Total', val: formatHours(sessionSeconds / 3600), icon: Clock, color: '#3b82f6' },
            { label: 'Session Idle', val: formatDuration(idleSeconds), icon: Coffee, color: '#f59e0b' },
            { label: 'Session Active', val: formatDuration(activeSeconds), icon: Zap, color: '#10b981' },
            { label: 'Active App', val: currentApp, icon: Monitor, color: '#8b5cf6' }
          ].map((stat, i) => (
            <motion.div 
              key={i} 
              initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.1 }}
              className="glass-card" style={{ padding: '20px' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                 <stat.icon size={16} color={stat.color} />
                 <span style={{ fontSize: '0.75rem', color: 'var(--wp-text-mute)', fontWeight: 600 }}>{stat.label}</span>
              </div>
              <div style={{ fontSize: '1.25rem', fontWeight: 800 }}>{stat.val}</div>
            </motion.div>
          ))}
        </div>

      </div>

      {/* AUTO CLOCK-IN NOTICE */}
      <AnimatePresence>
        {autoClockInNotice && (
          <motion.div
            initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
            style={{
              position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
              background: 'rgba(16,185,129,0.15)', border: '1px solid var(--wp-success)',
              borderRadius: '12px', padding: '12px 24px', zIndex: 1000,
              display: 'flex', alignItems: 'center', gap: '10px', backdropFilter: 'blur(10px)'
            }}
          >
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--wp-success)', boxShadow: '0 0 8px var(--wp-success)' }} />
            <span style={{ color: 'var(--wp-success)', fontWeight: 600, fontSize: '0.85rem' }}>
              Welcome back! Tracking resumed automatically.
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* IDLE PROMPT MODAL OVERLAY */}
      <AnimatePresence>
        {showIdlePrompt && (
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{
              position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
              backgroundColor: 'rgba(3, 5, 10, 0.8)', backdropFilter: 'blur(10px)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
            }}
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }} animate={{ scale: 1, y: 0 }}
              className="glass-card" style={{ padding: '40px', maxWidth: '400px', textAlign: 'center' }}
            >
              <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(245, 158, 11, 0.1)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px' }}>
                <Coffee size={32} color="var(--wp-warning)" />
              </div>
              <h2 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '12px' }}>Are you still here?</h2>
              <p style={{ color: 'var(--wp-text-mute)', marginBottom: '32px' }}>We've detected inactivity. Clock out or keep working to continue tracking.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <button className="wp-button wp-button-primary" style={{ width: '100%' }} onClick={() => setShowIdlePrompt(false)}>I'm Still Working</button>
                <button className="wp-button" style={{ width: '100%', background: 'rgba(255,255,255,0.05)' }} onClick={() => setIsActive(false)}>Clock Out Now</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )}
</AnimatePresence>

    </div>
  )
}

// ─── Root App ─────────────────────────────────────────────────────────────────
const App = () => {
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem('wp_token'))
  const [apiUrl, setApiUrl] = useState<string>(() => localStorage.getItem('wp_api_url') || '')
  const [tenantId, setTenantId] = useState<number | null>(() => {
    const t = localStorage.getItem('wp_tenant_id')
    return t ? parseInt(t) : null
  })

  // Re-initialize engine with stored credentials on every startup
  useEffect(() => {
    if (authToken && apiUrl) {
      const tid = localStorage.getItem('wp_tenant_id')
      console.log('[App] Restoring engine auth from localStorage on startup.')
      window.electron.ipcRenderer.send('save-auth', { url: apiUrl, token: authToken, tenantId: tid ? parseInt(tid) : null })
    }
  }, [])

  const handleLoginSuccess = (url: string, token: string, tid: number) => {
    window.electron.ipcRenderer.send('save-auth', { url, token, tenantId: tid })
    localStorage.setItem('wp_api_url', url)
    localStorage.setItem('wp_token', token)
    localStorage.setItem('wp_tenant_id', String(tid))
    setApiUrl(url)
    setAuthToken(token)
    setTenantId(tid)
  }

  const handleLogout = () => {
    window.electron.ipcRenderer.send('logout')
    localStorage.removeItem('wp_token')
    localStorage.removeItem('wp_api_url')
    localStorage.removeItem('wp_tenant_id')
    setAuthToken(null)
    setApiUrl('')
    setTenantId(null)
  }

  if (!authToken) {
    return <Login onLoginSuccess={handleLoginSuccess} />
  }

  return <Dashboard onLogout={handleLogout} apiUrl={apiUrl} token={authToken} tenantId={tenantId} />
}

export default App

