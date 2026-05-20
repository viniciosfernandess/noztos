'use client'

import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import type { ReactNode, CSSProperties } from 'react'

interface OnboardingContextValue {
  startTour: () => void
}

const OnboardingContext = createContext<OnboardingContextValue>({ startTour: () => {} })

export function useOnboarding() {
  return useContext(OnboardingContext)
}

interface Step {
  target?: string
  title: string
  description: string
  placement?: 'right' | 'left' | 'top' | 'bottom'
}

const STEPS: Step[] = [
  {
    title: 'Welcome to Noztos',
    description: "Your cloud-failover dev environment for Claude Code. Let's take a quick tour of the dashboard.",
  },
  {
    target: '[data-tour="claude-badge"]',
    title: 'Claude Code',
    description: 'Connect your local Claude Code instance. The dot shows if Claude is authenticated and running on your machine.',
    placement: 'right',
  },
  {
    target: '[data-tour="github-badge"]',
    title: 'GitHub',
    description: 'Link your GitHub account to push code and create pull requests directly from the cloud.',
    placement: 'right',
  },
  {
    target: '[data-tour="machine-badge"]',
    title: 'Your Machine',
    description: 'Shows whether your local companion is connected. When offline, your cloud environment stays available.',
    placement: 'right',
  },
  {
    target: '[data-tour="project-list"]',
    title: 'Projects',
    description: 'Each project maps to a repo. Open one to run Claude Code tasks, manage your workflow, and collaborate with AI agents.',
    placement: 'top',
  },
  {
    target: '[data-tour="phone-access"]',
    title: 'Phone Access',
    description: 'Generate a temporary public URL via Cloudflare so you can use noztos from your phone. Scan the QR code — no extra login steps.',
    placement: 'bottom',
  },
  {
    target: '[data-tour="new-workspace"]',
    title: 'New Workspace',
    description: 'Each workspace is an isolated git worktree. Create as many as you need to run parallel Claude Code sessions without conflicts.',
    placement: 'right',
  },
  {
    target: '[data-tour="new-chat"]',
    title: 'Multiple Chats per Workspace',
    description: 'Open several chat sessions inside the same workspace. Run parallel threads or switch context without losing any conversation.',
    placement: 'bottom',
  },
  {
    target: '[data-tour="delegate-workflows"]',
    title: 'Delegate with Workflows',
    description: 'Type /build in chat to kick off a full multi-agent team — Architect, Designer, Tester and more — that ships your feature end-to-end.',
    placement: 'left',
  },
]

const STORAGE_KEY = 'noztos_onboarding_done'
const SPOTLIGHT_PAD = 10

interface TargetRect { x: number; y: number; width: number; height: number }

export function OnboardingTourProvider({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<number | null>(null)
  const [rect, setRect] = useState<TargetRect | null>(null)
  const [winSize, setWinSize] = useState({ w: 0, h: 0 })
  const rafRef = useRef<number | null>(null)

  const startTour = useCallback(() => setStep(0), [])

  // Keyboard navigation — Escape closes, Arrow/Enter advances
  useEffect(() => {
    if (!isOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { finish(); return }
      if (e.key === 'ArrowRight' || e.key === 'Enter') { next(); return }
      if (e.key === 'ArrowLeft') { prev() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Auto-start on first dashboard visit
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (localStorage.getItem(STORAGE_KEY)) return
    if (window.location.pathname !== '/') return
    const t = setTimeout(() => setStep(0), 900)
    return () => clearTimeout(t)
  }, [])

  // Track window dimensions for SVG sizing
  useEffect(() => {
    function sync() {
      setWinSize({ w: window.innerWidth, h: window.innerHeight })
    }
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])

  // Measure target element rect on each step change
  useEffect(() => {
    if (step === null) { setRect(null); return }
    const target = STEPS[step]?.target
    if (!target) { setRect(null); return }

    function measure() {
      const el = document.querySelector(target!)
      if (el) {
        const r = el.getBoundingClientRect()
        setRect({ x: r.left, y: r.top, width: r.width, height: r.height })
      } else {
        setRect(null)
      }
    }

    measure()
    rafRef.current = requestAnimationFrame(measure)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [step, winSize])

  function finish() {
    localStorage.setItem(STORAGE_KEY, '1')
    setStep(null)
    setRect(null)
  }

  function next() {
    if (step === null) return
    if (step >= STEPS.length - 1) finish()
    else setStep(step + 1)
  }

  function prev() {
    if (step === null || step === 0) return
    setStep(step - 1)
  }

  const isOpen = step !== null
  const currentStep = isOpen ? STEPS[step!] : null
  const hasSpotlight = !!currentStep?.target && !!rect

  function getTooltipStyle(): CSSProperties {
    const CARD_W = 300
    const GAP = 20

    if (!rect || !currentStep?.target) {
      return {
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: CARD_W,
      }
    }

    const { x, y, width, height } = rect
    const placement = currentStep.placement ?? 'right'

    if (placement === 'right') {
      const left = x + width + SPOTLIGHT_PAD + GAP
      const top = Math.max(16, y + height / 2)
      return { position: 'fixed', left, top, transform: 'translateY(-50%)', width: CARD_W }
    }
    if (placement === 'left') {
      const right = winSize.w - x + SPOTLIGHT_PAD + GAP
      const top = Math.max(16, y + height / 2)
      return { position: 'fixed', right, top, transform: 'translateY(-50%)', width: CARD_W }
    }
    if (placement === 'bottom') {
      const left = Math.min(winSize.w - CARD_W - 16, Math.max(16, x + width / 2 - CARD_W / 2))
      const top = y + height + SPOTLIGHT_PAD + GAP
      return { position: 'fixed', left, top, width: CARD_W }
    }
    // top
    const left = Math.min(winSize.w - CARD_W - 16, Math.max(16, x + width / 2 - CARD_W / 2))
    const bottom = winSize.h - y + SPOTLIGHT_PAD + GAP
    return { position: 'fixed', left, bottom, width: CARD_W }
  }

  return (
    <OnboardingContext.Provider value={{ startTour }}>
      {children}

      {isOpen && currentStep && (
        <>
          {/* SVG spotlight — visuals only, no pointer events */}
          <svg
            aria-hidden
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 9998,
              pointerEvents: 'none',
              width: winSize.w,
              height: winSize.h,
            }}
          >
            <defs>
              <mask id="noztos-tour-mask">
                <rect width="100%" height="100%" fill="white" />
                {hasSpotlight && rect && (
                  <rect
                    x={rect.x - SPOTLIGHT_PAD}
                    y={rect.y - SPOTLIGHT_PAD}
                    width={rect.width + SPOTLIGHT_PAD * 2}
                    height={rect.height + SPOTLIGHT_PAD * 2}
                    rx="10"
                    fill="black"
                    style={{ transition: 'x 0.35s ease, y 0.35s ease, width 0.35s ease, height 0.35s ease' }}
                  />
                )}
              </mask>
            </defs>

            {/* Dark backdrop */}
            <rect
              width="100%"
              height="100%"
              fill="rgba(0,0,0,0.72)"
              mask="url(#noztos-tour-mask)"
            />

            {/* Violet glow ring around spotlight */}
            {hasSpotlight && rect && (
              <rect
                x={rect.x - SPOTLIGHT_PAD}
                y={rect.y - SPOTLIGHT_PAD}
                width={rect.width + SPOTLIGHT_PAD * 2}
                height={rect.height + SPOTLIGHT_PAD * 2}
                rx="10"
                fill="none"
                stroke="rgba(167,139,250,0.5)"
                strokeWidth="1.5"
                style={{ transition: 'x 0.35s ease, y 0.35s ease, width 0.35s ease, height 0.35s ease' }}
              />
            )}
          </svg>

          {/* Click-off backdrop */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9999 }}
            onClick={finish}
          />

          {/* Tooltip card */}
          <div
            style={{
              ...getTooltipStyle(),
              zIndex: 10000,
              backgroundColor: '#1C1C27',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 12,
              padding: 20,
              boxShadow: '0 25px 50px rgba(0,0,0,0.6)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Step dots */}
            <div className="mb-4 flex items-center gap-1.5">
              {STEPS.map((_, i) => (
                <span
                  key={i}
                  className="rounded-full transition-all duration-300"
                  style={{
                    height: 6,
                    width: i === step ? 20 : 6,
                    backgroundColor: i === step
                      ? '#a78bfa'
                      : i < step!
                        ? '#6d28d9'
                        : '#3f3f46',
                  }}
                />
              ))}
            </div>

            <h3 className="mb-1.5 text-sm font-semibold text-zinc-100">{currentStep.title}</h3>
            <p className="mb-5 text-xs leading-relaxed text-zinc-400">{currentStep.description}</p>

            <div className="flex items-center justify-between">
              <button
                onClick={finish}
                className="text-[11px] text-zinc-600 transition-colors hover:text-zinc-400"
              >
                Skip tour
              </button>

              <div className="flex items-center gap-2">
                {step! > 0 && (
                  <button
                    onClick={prev}
                    className="rounded-lg border border-white/10 px-3 py-1.5 text-[11px] text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
                  >
                    Back
                  </button>
                )}
                <button
                  onClick={next}
                  className="rounded-lg px-4 py-1.5 text-[11px] font-medium text-white transition-colors hover:opacity-90"
                  style={{ backgroundColor: '#7c3aed' }}
                >
                  {step! >= STEPS.length - 1 ? 'Done' : 'Next →'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </OnboardingContext.Provider>
  )
}
