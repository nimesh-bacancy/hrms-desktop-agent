import React, { useState } from 'react'
import { LogIn, Settings, Building2, CheckCircle } from 'lucide-react'
import { LogoIcon } from './LogoIcon'
import { motion, AnimatePresence } from 'framer-motion'

const DEFAULT_API_URL = 'https://api.projectsoftware.com/api/v1'

const Login = ({ onLoginSuccess }: { onLoginSuccess: (url: string, token: string, tenantId: number) => void }) => {
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL)
  const [subdomain, setSubdomain] = useState('')
  const [tenantId, setTenantId] = useState<number | null>(null)
  const [tenantName, setTenantName] = useState('')
  const [tenantVerifying, setTenantVerifying] = useState(false)
  const [tenantError, setTenantError] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [mfaRequired, setMfaRequired] = useState(false)
  const [mfaToken, setMfaToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [launchAtStartup, setLaunchAtStartup] = useState(false)
  const [step, setStep] = useState<'org' | 'login'>('org')

  React.useEffect(() => {
    // @ts-ignore
    window.api.getLaunchAtStartup().then(setLaunchAtStartup)
  }, [])

  const handleToggleStartup = (val: boolean) => {
    setLaunchAtStartup(val)
    // @ts-ignore
    window.api.setLaunchAtStartup(val)
  }

  // Step 1 — Verify organization subdomain
  const handleVerifyOrg = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!subdomain.trim()) return
    setTenantVerifying(true)
    setTenantError('')
    setTenantId(null)
    setTenantName('')

    try {
      const res = await fetch(`${apiUrl}/tenants/resolve?subdomain=${encodeURIComponent(subdomain.trim().toLowerCase())}`)
      const data = await res.json()
      if (res.ok && data.id) {
        setTenantId(data.id)
        setTenantName(data.name)
        setStep('login')
      } else {
        setTenantError(data.detail || 'Organization not found. Check the name and try again.')
      }
    } catch {
      setTenantError('Could not reach the server. Check your network and API URL.')
    } finally {
      setTenantVerifying(false)
    }
  }

  // Step 2 — Login with email + password
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!tenantId) return
    setLoading(true)
    setError('')

    const extraHeaders: Record<string, string> = {
      'X-Tenant-ID': String(tenantId),
    }

    try {
      if (mfaRequired) {
        const mfaRes = await fetch(`${apiUrl}/auth/2fa/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...extraHeaders },
          body: JSON.stringify({ mfa_token: mfaToken, code: totp })
        })
        const mfaData = await mfaRes.json()
        if (mfaRes.ok && mfaData.access_token) {
          onLoginSuccess(apiUrl, mfaData.access_token, tenantId)
          return
        }
        setError(mfaData.detail || 'Invalid 2FA code. Please try again.')
        return
      }

      const formData = new URLSearchParams()
      formData.append('username', email)
      formData.append('password', password)

      const response = await fetch(`${apiUrl}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extraHeaders },
        body: formData.toString()
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.detail || 'Incorrect email or password.')
        return
      }

      if (data.mfa_required) {
        setMfaToken(data.mfa_token)
        setMfaRequired(true)
        setError('')
        return
      }

      if (data.setup_required) {
        setError('Please complete two-factor setup in your web browser first.')
        return
      }

      if (data.access_token) {
        onLoginSuccess(apiUrl, data.access_token, tenantId)
      } else {
        setError('Unexpected server response. Please try again.')
      }
    } catch (err: any) {
      setError(err.message || 'Network error. Could not reach the server.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      background: 'radial-gradient(circle at top left, #0f172a 0%, #03050a 100%)',
      color: 'var(--wp-text)',
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2rem',
      overflow: 'hidden'
    }}>

      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 30 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="glass-card"
        style={{ width: '100%', maxWidth: '440px', padding: '3rem 2.5rem', position: 'relative', zIndex: 1 }}
      >
        <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
          <LogoIcon size={56} />
          <h1 style={{ fontSize: '1.8rem', fontWeight: 800, margin: '1rem 0 0.5rem', letterSpacing: '-0.5px' }}>
            WorkPulse HR <span style={{ color: 'var(--wp-accent)' }}>Agent</span>
          </h1>
          <p style={{ color: 'var(--wp-text-mute)', fontSize: '0.9rem' }}>
            Enterprise time tracking for high-performance teams.
          </p>
        </div>

        {/* ── Step 1: Organization ── */}
        <AnimatePresence mode="wait">
          {step === 'org' && (
            <motion.form
              key="org"
              initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
              onSubmit={handleVerifyOrg}
              style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--wp-text-mute)' }}>
                  Organization Name
                </label>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <Building2 size={16} style={{ position: 'absolute', left: '14px', color: 'var(--wp-text-mute)' }} />
                  <input
                    type="text"
                    value={subdomain}
                    onChange={e => { setSubdomain(e.target.value.toLowerCase().replace(/\s/g, '')); setTenantError('') }}
                    placeholder="yourcompany"
                    style={{
                      width: '100%', background: 'rgba(255,255,255,0.03)',
                      border: `1px solid ${tenantError ? 'var(--wp-danger)' : 'var(--glass-border)'}`,
                      borderRadius: '12px', padding: '14px 14px 14px 40px',
                      color: 'white', outline: 'none', fontSize: '1rem'
                    }}
                    required autoFocus
                  />
                </div>
                {tenantError && (
                  <span style={{ fontSize: '0.75rem', color: 'var(--wp-danger)' }}>{tenantError}</span>
                )}
                <span style={{ fontSize: '0.72rem', color: 'var(--wp-text-mute)' }}>
                  Enter your company's WorkPulse HR subdomain
                </span>
              </div>

              <button type="submit" className="wp-button wp-button-primary" disabled={tenantVerifying || !subdomain.trim()}>
                {tenantVerifying ? 'Verifying...' : 'Continue →'}
              </button>

              {/* Advanced */}
              <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: '16px' }}>
                <button type="button" onClick={() => setShowAdvanced(!showAdvanced)}
                  style={{ background: 'none', border: 'none', color: 'var(--wp-text-mute)', cursor: 'pointer', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '6px', padding: 0 }}>
                  <Settings size={14} />
                  {showAdvanced ? 'Hide Advanced' : 'Network Settings'}
                </button>
                {showAdvanced && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} style={{ overflow: 'hidden', marginTop: '12px' }}>
                    <label style={{ fontSize: '0.7rem', color: 'var(--wp-text-mute)', display: 'flex', justifyContent: 'space-between' }}>
                      <span>API URL</span>
                      <span style={{ color: 'var(--wp-accent)', cursor: 'pointer', fontWeight: 600 }}
                        onClick={() => setApiUrl('http://localhost:8000/api/v1')}>Use Localhost</span>
                    </label>
                    <input type="text" value={apiUrl} onChange={e => setApiUrl(e.target.value)}
                      style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--glass-border)', borderRadius: '8px', padding: '10px', color: 'var(--wp-text-mute)', fontSize: '0.75rem', marginTop: '4px' }} />
                  </motion.div>
                )}

                <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div onClick={() => handleToggleStartup(!launchAtStartup)}
                    style={{ width: '36px', height: '20px', borderRadius: '10px', background: launchAtStartup ? 'var(--wp-success)' : 'rgba(255,255,255,0.1)', position: 'relative', cursor: 'pointer', transition: 'all 0.3s' }}>
                    <motion.div animate={{ x: launchAtStartup ? 18 : 2 }}
                      style={{ width: '16px', height: '16px', borderRadius: '50%', background: 'white', top: '2px', position: 'absolute' }} />
                  </div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--wp-text-mute)', cursor: 'pointer' }} onClick={() => handleToggleStartup(!launchAtStartup)}>
                    Launch WorkPulse HR at startup
                  </span>
                </div>
              </div>
            </motion.form>
          )}

          {/* ── Step 2: Email + Password ── */}
          {step === 'login' && !mfaRequired && (
            <motion.form
              key="login"
              initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}
              onSubmit={handleLogin}
              style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}
            >
              {/* Org badge */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '10px', padding: '10px 14px' }}>
                <CheckCircle size={16} style={{ color: '#6366f1', flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: '#a5b4fc' }}>{tenantName}</div>
                  <div style={{ fontSize: '10px', color: 'var(--wp-text-mute)' }}>{subdomain}.projectsoftware.com</div>
                </div>
                <button type="button" onClick={() => { setStep('org'); setError(''); setTenantId(null) }}
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--wp-text-mute)', cursor: 'pointer', fontSize: '11px' }}>
                  Change
                </button>
              </div>

              {error && (
                <motion.div initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                  style={{ backgroundColor: 'rgba(239,68,68,0.1)', color: 'var(--wp-danger)', padding: '12px 16px', borderRadius: '12px', fontSize: '0.85rem', border: '1px solid rgba(239,68,68,0.2)' }}>
                  {error}
                </motion.div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--wp-text-mute)' }}>Email Address</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--glass-border)', borderRadius: '12px', padding: '14px', color: 'white', outline: 'none' }}
                  required autoFocus />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--wp-text-mute)' }}>Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--glass-border)', borderRadius: '12px', padding: '14px', color: 'white', outline: 'none' }}
                  required />
              </div>

              <button type="submit" className="wp-button wp-button-primary" disabled={loading} style={{ marginTop: '8px' }}>
                <LogIn size={18} />
                {loading ? 'Authenticating...' : 'Sign In'}
              </button>
            </motion.form>
          )}

          {/* ── Step 2b: MFA ── */}
          {step === 'login' && mfaRequired && (
            <motion.form
              key="mfa"
              initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
              onSubmit={handleLogin}
              style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}
            >
              <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
                <h2 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>Two-Factor Authentication</h2>
                <p style={{ fontSize: '0.8rem', color: 'var(--wp-text-mute)', marginTop: '8px' }}>Enter the code from your authenticator app</p>
              </div>
              {error && (
                <div style={{ backgroundColor: 'rgba(239,68,68,0.1)', color: 'var(--wp-danger)', padding: '12px 16px', borderRadius: '12px', fontSize: '0.85rem', border: '1px solid rgba(239,68,68,0.2)' }}>{error}</div>
              )}
              <input type="text" value={totp} onChange={e => setTotp(e.target.value)}
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--glass-border)', borderRadius: '12px', padding: '16px', color: 'white', fontSize: '1.5rem', textAlign: 'center', letterSpacing: '8px', outline: 'none' }}
                maxLength={6} autoFocus required />
              <button type="submit" className="wp-button wp-button-primary" disabled={loading}>
                {loading ? 'Verifying...' : 'Verify Identity'}
              </button>
              <button type="button" onClick={() => setMfaRequired(false)}
                style={{ background: 'none', border: 'none', color: 'var(--wp-text-mute)', cursor: 'pointer', fontSize: '0.8rem' }}>
                ← Back to login
              </button>
            </motion.form>
          )}
        </AnimatePresence>
      </motion.div>

      <div style={{ position: 'absolute', top: '-10%', left: '-10%', width: '40%', height: '40%', background: 'rgba(59,130,246,0.05)', filter: 'blur(100px)', zIndex: 0 }} />
      <div style={{ position: 'absolute', bottom: '-10%', right: '-10%', width: '40%', height: '40%', background: 'rgba(139,92,246,0.05)', filter: 'blur(100px)', zIndex: 0 }} />
    </div>
  )
}

export default Login
