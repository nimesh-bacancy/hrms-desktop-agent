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
const Dashboard = ({ onLogout, apiUrl, token }: { onLogout: () => void; apiUrl: string; token: string }) => {
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

  useEffect(() => {
    // @ts-ignore
    window.api.getLaunchAtStartup().then(setLaunchAtStartup)
  }, [])

  useEffect(() => {
    window.electron.ipcRenderer.invoke('get-app-version').then((v: string) => setAppVersion(v))
  }, [])

  // Live active-window feed from engine
  useEffect(() => {
    const handler = (_: any, title: string) => setCurrentApp(title || '—')
    window.electron.ipcRenderer.on('active-window-update', handler)
    return () => { window.electron.ipcRenderer.removeListener('active-window-update', handler) }
  }, [])

  // Reset per-session counters whenever a new tracking period starts
  useEffect(() => {
    if (isActive) {
      setIdleSeconds(0)
      setActiveSeconds(0)
    }
  }, [isActive])

  const handleToggleStartup = (val: boolean) => {
    setLaunchAtStartup(val)
    // @ts-ignore
    window.api.setLaunchAtStartup(val)
  }
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const promptFiredRef = useRef<boolean>(false)
  const wasAutoStoppedRef = useRef<boolean>(false)
  const autoStopTimeRef = useRef<number | null>(null)
  const activityWatchRef = useRef<NodeJS.Timeout | null>(null)
  const [autoClockInNotice, setAutoClockInNotice] = useState(false)

  const authHeaders = { Authorization: `Bearer ${token}` }

  // Sync offline queue when coming back online
  useEffect(() => {
    const handleOnline = () => {
      console.log('App back online, triggering sync...')
      window.electron.ipcRenderer.send('trigger-sync')
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [])

  // Global Axios Interceptor for 401 Unauthorized (Token Expiry)
  useEffect(() => {
    const interceptor = axios.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          console.warn('Token expired or invalid. Logging out.')
          onLogout()
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
        } else if (statusResp.data.is_clocked_in && statusResp.data.last_clock_in) {
          setIsActive(true)
          seedSessionFromStatus(statusResp.data)
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

        // Skip idle detection entirely while on break — user is intentionally away
        if (isOnBreak) return

        try {
          // Fetch exact OS idle seconds directly via IPC
          const systemIdle: number = await window.electron.ipcRenderer.invoke('get-idle-time')

          const IDLE_PROMPT_THRESHOLD = 180 // 3 minutes
          const AUTO_STOP_THRESHOLD = 300 // 5 minutes

          if (systemIdle >= AUTO_STOP_THRESHOLD) {
             wasAutoStoppedRef.current = true
             autoStopTimeRef.current = Date.now()
             setIsActive(false)
             setShowIdlePrompt(false)
             return
          }

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

  // Activity watcher — only runs after an AUTO stop (not manual clock-out)
  // Polls every 5s; when user touches keyboard/mouse, auto-clocks back in
  useEffect(() => {
    if (activityWatchRef.current) {
      clearInterval(activityWatchRef.current)
      activityWatchRef.current = null
    }

    if (!isActive && wasAutoStoppedRef.current) {
      activityWatchRef.current = setInterval(async () => {
        try {
          const idleTime: number = await window.electron.ipcRenderer.invoke('get-idle-time')
          if (idleTime < 30) {
            autoStopTimeRef.current = null
            wasAutoStoppedRef.current = false
            clearInterval(activityWatchRef.current!)
            activityWatchRef.current = null
            setIsActive(true)
            // After engine has had time to clock back in (~2.5s), re-sync timer
            // from backend so it matches the web ClockControl exactly
            setTimeout(async () => {
              try {
                const resp = await axios.get(`${apiUrl}/attendance/status`, { headers: authHeaders })
                setDayStats(resp.data)
                if (resp.data.is_clocked_in && resp.data.last_clock_in) {
                  const completedSec = Math.round((resp.data.today_total_hours || 0) * 3600)
                  const breakSec = Math.round((resp.data.today_break_hours || 0) * 3600)
                  const start = new Date(resp.data.last_clock_in).getTime()
                  const grossSec = Math.max(0, Math.floor((Date.now() - start) / 1000))
                  const ongoingBreakSec = (resp.data.is_on_break && resp.data.last_break_start)
                    ? Math.max(0, Math.floor((Date.now() - new Date(resp.data.last_break_start).getTime()) / 1000))
                    : 0
                  setSessionSeconds(completedSec + Math.max(0, grossSec - breakSec - ongoingBreakSec))
                }
              } catch (_) {}
            }, 2500)
            setAutoClockInNotice(true)
            setTimeout(() => setAutoClockInNotice(false), 5000)
          }
        } catch (_) {}
      }, 5000)
    }

    return () => {
      if (activityWatchRef.current) {
        clearInterval(activityWatchRef.current)
        activityWatchRef.current = null
      }
    }
  }, [isActive])

  // Periodic stats refresh — re-syncs session timer with backend every 60s
  useEffect(() => {
    if (!isActive) return
    const headers = { Authorization: `Bearer ${token}` }
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
               <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
                  <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: 'rgba(59, 130, 246, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                     <Zap size={20} color="var(--wp-accent)" />
                  </div>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--wp-text-mute)' }}>Session Split</div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 700 }}>{sessionActivePct}% Active</div>
                  </div>
               </div>
               <div style={{ display: 'flex', height: '6px', gap: '4px' }}>
                  <div style={{ flex: sessionActivePct, background: 'var(--wp-success)', borderRadius: '3px' }} />
                  <div style={{ flex: sessionIdlePct, background: 'var(--wp-warning)', borderRadius: '3px' }} />
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

  // CRITICAL: Re-initialize the main process engine with stored credentials on every startup.
  // The renderer reads the token from localStorage for its own state, but the main process
  // engine is a separate Node.js process that loses its in-memory auth on every app quit.
  // Without this, engine.startTracking() silently returns because engine.token is empty.
  useEffect(() => {
    if (authToken && apiUrl) {
      console.log('[App] Restoring engine auth from localStorage on startup.')
      window.electron.ipcRenderer.send('save-auth', { url: apiUrl, token: authToken })
    }
  }, []) // Run once on mount only

  const handleLoginSuccess = (url: string, token: string) => {
    window.electron.ipcRenderer.send('save-auth', { url, token })
    localStorage.setItem('wp_api_url', url)
    localStorage.setItem('wp_token', token)
    setApiUrl(url)
    setAuthToken(token)
  }

  const handleLogout = () => {
    window.electron.ipcRenderer.send('logout')
    localStorage.removeItem('wp_token')
    localStorage.removeItem('wp_api_url')
    setAuthToken(null)
    setApiUrl('')
  }

  if (!authToken) {
    return <Login onLoginSuccess={handleLoginSuccess} />
  }

  return <Dashboard onLogout={handleLogout} apiUrl={apiUrl} token={authToken} />
}

export default App

