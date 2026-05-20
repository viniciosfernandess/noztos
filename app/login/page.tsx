'use client'

// Unified auth page — Sign in OR Create account in one screen.
//
// Visual language matches the noztos marketing site so the user lands
// here without a jarring shift: same fonts (Space Grotesk + JetBrains Mono),
// same accent green, same scanlines + ambient grid, same status bar
// vibe. Single tabbed control switches between two minimal forms; both
// hit the existing /api/auth/login and /api/auth/register endpoints
// unchanged. /register stays as a redirect → here.

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Mode = 'signin' | 'signup' | 'forgot'

export default function AuthPage() {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('signin')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Tracks 409 from /register so we can offer a "Sign in with this
  // email" button instead of just an error string. Anti-friction —
  // most users who hit this either forgot they had an account or
  // typo'd a different one.
  const [emailExists, setEmailExists] = useState<string | null>(null)
  // Email pre-fill used when switching modes carries the value across.
  const [emailPrefill, setEmailPrefill] = useState('')
  // forgot-password "we sent the email" confirmation state. Same
  // response shape whether the email exists or not (anti-enumeration).
  const [forgotSent, setForgotSent] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    setEmailExists(null)
    setLoading(true)
    const form = new FormData(e.currentTarget)
    try {
      if (mode === 'signin') {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: form.get('email') as string,
            password: form.get('password') as string,
          }),
        })
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          throw new Error(j.error ?? 'Sign in failed')
        }
        window.location.href = '/'
        return
      } else if (mode === 'signup') {
        const password = form.get('password') as string
        const confirm = form.get('confirmPassword') as string
        if (password !== confirm) throw new Error('Passwords do not match')
        const email = form.get('email') as string
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.get('name') as string,
            email,
            password,
          }),
        })
        if (res.status === 409) {
          // Email already in use — capture it so we can offer a
          // one-click switch to sign-in mode with the field pre-filled.
          setEmailExists(email)
          setLoading(false)
          return
        }
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          throw new Error(j.error ?? 'Registration failed')
        }
        // Hard navigation — same WebKit-bug-219650 workaround as the
        // signin branch above.
        window.location.href = '/'
        return
      } else {
        // forgot
        const email = form.get('email') as string
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        })
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          throw new Error(j.error ?? 'Could not send reset email')
        }
        setForgotSent(true)
        setLoading(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setLoading(false)
    }
  }

  function switchMode(next: Mode, carryEmail?: string) {
    setMode(next)
    setError('')
    setEmailExists(null)
    setForgotSent(false)
    if (typeof carryEmail === 'string') setEmailPrefill(carryEmail)
  }

  return (
    <>
      <style jsx global>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500&display=swap');
        :root {
          --bg:       oklch(0.13 0.008 255);
          --bg-2:     oklch(0.16 0.009 255);
          --bg-3:     oklch(0.19 0.01  255);
          --fg:       oklch(0.96 0.005 255);
          --muted:    oklch(0.62 0.012 255);
          --muted-2:  oklch(0.45 0.012 255);
          --line:     oklch(0.26 0.012 255);
          --line-2:   oklch(0.22 0.012 255);
          --accent:   oklch(0.88 0.19 130);
          --accent-2: oklch(0.70 0.18 130);
          --danger:   oklch(0.72 0.18 25);
          --display:  'Space Grotesk', ui-sans-serif, system-ui, sans-serif;
          --mono:     'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        html, body { background: var(--bg); color: var(--fg); margin: 0; padding: 0; overflow-x: hidden; }
        body { font-family: var(--display); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
        ::selection { background: var(--accent); color: #000; }
      `}</style>

      {/* Ambient grid + scanlines — same as the marketing site */}
      <div
        aria-hidden
        style={{
          position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none',
          background:
            'radial-gradient(1200px 600px at 80% -10%, oklch(0.88 0.19 130 / 0.08), transparent 60%),' +
            'radial-gradient(900px 500px at 10% 110%, oklch(0.55 0.18 260 / 0.07), transparent 60%),' +
            'linear-gradient(var(--line-2) 1px, transparent 1px) 0 0 / 100% 64px,' +
            'linear-gradient(90deg, var(--line-2) 1px, transparent 1px) 0 0 / 64px 100%',
          maskImage: 'radial-gradient(ellipse at 50% 30%, black 30%, transparent 80%)',
          WebkitMaskImage: 'radial-gradient(ellipse at 50% 30%, black 30%, transparent 80%)',
          opacity: 0.55,
        }}
      />
      <div
        aria-hidden
        style={{
          position: 'fixed', inset: 0, zIndex: 1, pointerEvents: 'none',
          background: 'repeating-linear-gradient(to bottom, transparent 0 2px, oklch(1 0 0 / 0.012) 2px 3px)',
          mixBlendMode: 'overlay',
        }}
      />

      {/* Top nav — exact match to the marketing site so the brand
          doesn't shift between routes. Same max-width row, same 14×28
          padding, same brand size + letter-spacing. */}
      <nav
        style={{
          position: 'relative', zIndex: 10,
          borderBottom: '1px solid var(--line)',
          background: 'oklch(0.13 0.008 255 / 0.7)', backdropFilter: 'blur(8px)',
        }}
      >
        <div style={{
          maxWidth: 1280, margin: '0 auto',
          padding: '14px 28px',
          display: 'flex', alignItems: 'center', gap: 32,
        }}>
          <a
            href="/"
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              color: 'var(--fg)',
              fontFamily: 'var(--display)', fontWeight: 600,
              fontSize: 18, letterSpacing: '-0.01em',
            }}
          >
            noztos
          </a>
          <span style={{
            marginLeft: 'auto',
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)',
            textTransform: 'uppercase', letterSpacing: '0.14em',
          }}>
            {mode === 'signin' ? 'authenticate' : mode === 'signup' ? 'create account' : 'reset password'}
          </span>
        </div>
      </nav>

      <main style={{ position: 'relative', zIndex: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 'calc(100vh - 50px)', padding: '40px 20px' }}>
        <div style={{ width: '100%', maxWidth: 420 }}>
          {/* Mode switcher — Sign in | Create account. Forgot-password
              gets its own pill replacing the segments while active so
              the UI stays minimal. */}
          {mode !== 'forgot' && (
            <div
              style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr',
                border: '1px solid var(--line)', borderRadius: 4,
                fontFamily: 'var(--mono)', fontSize: 11,
                textTransform: 'uppercase', letterSpacing: '0.1em',
                marginBottom: 32,
              }}
            >
              <button
                type="button"
                onClick={() => switchMode('signin')}
                style={{
                  padding: '10px 14px',
                  background: mode === 'signin' ? 'var(--bg-3)' : 'transparent',
                  color: mode === 'signin' ? 'var(--fg)' : 'var(--muted)',
                  borderRight: '1px solid var(--line)',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => switchMode('signup')}
                style={{
                  padding: '10px 14px',
                  background: mode === 'signup' ? 'var(--bg-3)' : 'transparent',
                  color: mode === 'signup' ? 'var(--fg)' : 'var(--muted)',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                Create account
              </button>
            </div>
          )}

          {/* Heading */}
          <div style={{ marginBottom: 28 }}>
            <h1 style={{ fontFamily: 'var(--display)', fontSize: 32, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.1, margin: 0 }}>
              {mode === 'signin' && <>Welcome <span style={{ color: 'var(--accent)' }}>back.</span></>}
              {mode === 'signup' && <>Start <span style={{ color: 'var(--accent)' }}>delegating.</span></>}
              {mode === 'forgot' && <>Reset your <span style={{ color: 'var(--accent)' }}>password.</span></>}
            </h1>
            <p style={{ marginTop: 10, color: 'var(--muted)', fontSize: 14, lineHeight: 1.5 }}>
              {mode === 'signin' && 'Sign in to continue your workflows.'}
              {mode === 'signup' && 'Free to start. Local agent, cloud fallback, autonomous workflows.'}
              {mode === 'forgot' && (forgotSent
                ? 'Check your inbox — if an account exists for that email, the reset link is on the way.'
                : 'Type your email and we’ll send you a one-time reset link.')}
            </p>
          </div>

          {/* Email-already-exists CTA. Shown when /register returned 409.
              Offers a direct switch to sign-in with the email pre-filled,
              avoiding the dead-end of "stuck on register, must re-type
              email manually". */}
          {emailExists && (
            <div style={{
              marginBottom: 18, padding: '14px 16px', borderRadius: 4,
              border: '1px solid var(--line)', background: 'var(--bg-2)',
              display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between',
            }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>
                <span style={{ color: 'var(--fg)' }}>{emailExists}</span> already has an account.
              </div>
              <button
                type="button"
                onClick={() => switchMode('signin', emailExists)}
                style={{
                  padding: '8px 12px', border: '1px solid var(--accent)',
                  background: 'oklch(0.88 0.19 130 / 0.15)', color: 'var(--accent)',
                  fontFamily: 'var(--mono)', fontSize: 11, textTransform: 'uppercase',
                  letterSpacing: '0.06em', cursor: 'pointer', borderRadius: 3,
                }}
              >
                Sign in →
              </button>
            </div>
          )}

          {!forgotSent && (
          /* Native action + method so the form works even when React
             hasn't hydrated (HMR WebSocket can't establish over a
             Cloudflare quick tunnel — without hydration, onSubmit
             never fires and the browser would otherwise default to
             GET /login?email=…&password=… which leaks the password
             into the URL bar and never authenticates). The JS
             handleSubmit still runs first when hydrated; it calls
             e.preventDefault() before the native submit happens. */
          <form
            onSubmit={handleSubmit}
            action={mode === 'signup' ? '/api/auth/register' : mode === 'forgot' ? '/api/auth/forgot-password' : '/api/auth/login'}
            method="POST"
            encType="application/x-www-form-urlencoded"
            style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            {error && (
              <div style={{
                padding: '10px 12px', borderRadius: 4,
                border: '1px solid oklch(0.72 0.18 25 / 0.4)',
                background: 'oklch(0.72 0.18 25 / 0.08)',
                color: 'oklch(0.85 0.15 25)', fontSize: 12,
                fontFamily: 'var(--mono)',
              }}>
                {error}
              </div>
            )}

            {mode === 'signup' && (
              <Field name="name" label="Name" type="text" autoComplete="name" required />
            )}
            <Field name="email" label="Email" type="email" autoComplete="email" required placeholder="you@noztos.com" defaultValue={emailPrefill} />
            {mode !== 'forgot' && (
              <Field
                name="password"
                label="Password"
                type="password"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                required
              />
            )}
            {mode === 'signup' && (
              <Field name="confirmPassword" label="Confirm password" type="password" autoComplete="new-password" required />
            )}

            {/* Forgot-password link sits just under the password field in
                sign-in mode. Aligned right, small mono so it doesn't
                compete with the primary button. */}
            {mode === 'signin' && (
              <div style={{ marginTop: -6, textAlign: 'right' }}>
                <button
                  type="button"
                  onClick={() => switchMode('forgot')}
                  style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', cursor: 'pointer', padding: 0 }}
                >
                  Forgot password?
                </button>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                marginTop: 12,
                padding: '12px 16px',
                border: '1px solid var(--accent)',
                background: loading ? 'oklch(0.88 0.19 130 / 0.4)' : 'var(--accent)',
                color: '#000',
                fontFamily: 'var(--mono)',
                fontSize: 12,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                fontWeight: 500,
                cursor: loading ? 'wait' : 'pointer',
                transition: 'background 0.15s',
                borderRadius: 4,
              }}
            >
              {loading
                ? (mode === 'signin' ? 'Signing in…' : mode === 'signup' ? 'Creating…' : 'Sending…')
                : (mode === 'signin' ? 'Sign in →' : mode === 'signup' ? 'Create account →' : 'Send reset link →')}
            </button>
          </form>
          )}

          {/* Hint footer — mode-aware cross-links */}
          <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--line-2)', color: 'var(--muted-2)', fontSize: 11, fontFamily: 'var(--mono)', textAlign: 'center' }}>
            {mode === 'signin' && (
              <>New here? <button type="button" onClick={() => switchMode('signup')} style={{ color: 'var(--accent)', cursor: 'pointer', padding: 0 }}>Create an account →</button></>
            )}
            {mode === 'signup' && (
              <>Already have an account? <button type="button" onClick={() => switchMode('signin')} style={{ color: 'var(--accent)', cursor: 'pointer', padding: 0 }}>Sign in →</button></>
            )}
            {mode === 'forgot' && (
              <button type="button" onClick={() => switchMode('signin')} style={{ color: 'var(--accent)', cursor: 'pointer', padding: 0 }}>← Back to sign in</button>
            )}
          </div>
        </div>
      </main>
    </>
  )
}

function Field({ name, label, type, autoComplete, required, placeholder, defaultValue }: {
  name: string
  label: string
  type: string
  autoComplete?: string
  required?: boolean
  placeholder?: string
  defaultValue?: string
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{
        fontFamily: 'var(--mono)', fontSize: 10,
        textTransform: 'uppercase', letterSpacing: '0.1em',
        color: 'var(--muted)',
      }}>
        {label}
      </span>
      <input
        key={defaultValue || name}
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        placeholder={placeholder}
        defaultValue={defaultValue}
        style={{
          padding: '10px 12px',
          background: 'var(--bg-2)',
          border: '1px solid var(--line)',
          color: 'var(--fg)',
          fontFamily: 'var(--display)',
          fontSize: 14,
          outline: 'none',
          borderRadius: 4,
          transition: 'border-color 0.15s',
        }}
        onFocus={(e) => { e.currentTarget.style.borderColor = 'oklch(0.88 0.19 130 / 0.6)' }}
        onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--line)' }}
      />
    </label>
  )
}
