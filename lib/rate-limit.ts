// ── In-process rate limiter ────────────────────────────────────────────
//
// Token-bucket per key (userId, IP, whatever the caller passes). Cheap,
// zero-dependency, works in a single Next.js process. When we scale out
// horizontally we'll swap the Map for Redis — same interface.
//
// Usage:
//   const rl = rateLimit({ tokensPerInterval: 100, intervalMs: 60_000 })
//   if (!rl.take(userId)) return new Response('Too many requests', { status: 429 })

interface Bucket {
  tokens: number
  lastRefill: number
}

interface RateLimitConfig {
  // How many operations allowed per interval.
  tokensPerInterval: number
  // Window in milliseconds.
  intervalMs: number
}

export interface RateLimiter {
  take: (key: string, cost?: number) => boolean
  remaining: (key: string) => number
}

const buckets = new Map<string, Map<string, Bucket>>()

export function rateLimit(config: RateLimitConfig, bucketName = 'default'): RateLimiter {
  if (!buckets.has(bucketName)) buckets.set(bucketName, new Map())
  const bucket = buckets.get(bucketName)!
  const refillPerMs = config.tokensPerInterval / config.intervalMs

  function refill(b: Bucket): void {
    const now = Date.now()
    const elapsed = now - b.lastRefill
    if (elapsed <= 0) return
    b.tokens = Math.min(config.tokensPerInterval, b.tokens + elapsed * refillPerMs)
    b.lastRefill = now
  }

  return {
    take(key: string, cost = 1): boolean {
      let b = bucket.get(key)
      if (!b) {
        b = { tokens: config.tokensPerInterval, lastRefill: Date.now() }
        bucket.set(key, b)
      }
      refill(b)
      if (b.tokens < cost) return false
      b.tokens -= cost
      return true
    },
    remaining(key: string): number {
      const b = bucket.get(key)
      if (!b) return config.tokensPerInterval
      refill(b)
      return Math.floor(b.tokens)
    },
  }
}

// Prune buckets older than this to keep memory bounded. Called
// opportunistically from take() via module init below.
const GC_INTERVAL_MS = 5 * 60_000
const BUCKET_TTL_MS = 30 * 60_000
setInterval(() => {
  const cutoff = Date.now() - BUCKET_TTL_MS
  for (const [name, bucket] of buckets) {
    for (const [key, b] of bucket) {
      if (b.lastRefill < cutoff) bucket.delete(key)
    }
    if (bucket.size === 0) buckets.delete(name)
  }
}, GC_INTERVAL_MS).unref?.()
