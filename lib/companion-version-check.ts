// Cached lookup of the latest @noztos/companion version published
// on NPM. The version check is on the hot path of /api/companion/register
// (which fires every 10s as the daemon heartbeat), so we cache for
// 30 minutes — a new release shows up in the UI banner within at most
// 30 min of being published, which is fine for an opt-in update flow.
//
// On NPM 404 / network error the function returns null and the caller
// treats "update unknown" as "no update available" — never block the
// hot path on a slow / broken registry call.
//
// Comparison uses the standard semver shape "x.y.z" only — pre-release
// suffixes are not considered. The caller's compareVersions() helper
// returns true when a strictly newer x.y.z exists.

const NPM_REGISTRY = 'https://registry.npmjs.org/@noztos/companion/latest'
const CACHE_TTL_MS = 30 * 60 * 1000

interface CachedLookup {
  version: string | null
  fetchedAt: number
}

let cache: CachedLookup | null = null
let inflight: Promise<string | null> | null = null

export async function getLatestCompanionVersion(): Promise<string | null> {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.version
  }
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const res = await fetch(NPM_REGISTRY, {
        // Short timeout so a stalled NPM mirror never wedges a daemon
        // register. AbortSignal.timeout requires Node 17.3+.
        signal: AbortSignal.timeout(3_000),
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) {
        cache = { version: null, fetchedAt: Date.now() }
        return null
      }
      const data = (await res.json()) as { version?: string }
      const v = typeof data.version === 'string' ? data.version : null
      cache = { version: v, fetchedAt: Date.now() }
      return v
    } catch {
      cache = { version: null, fetchedAt: Date.now() }
      return null
    } finally {
      inflight = null
    }
  })()
  return inflight
}

// Parses "1.2.3" → [1, 2, 3]. Returns null for unparseable input so
// callers can detect "unknown" vs "older".
function parse(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

/**
 * Returns true if `latest` is strictly newer than `current`. Treats
 * unparseable inputs as "no update" — better to say nothing than to
 * nag the user on garbage data.
 */
export function isUpdateAvailable(current: string | undefined | null, latest: string | null): boolean {
  if (!current || !latest) return false
  const c = parse(current)
  const l = parse(latest)
  if (!c || !l) return false
  if (l[0] !== c[0]) return l[0] > c[0]
  if (l[1] !== c[1]) return l[1] > c[1]
  return l[2] > c[2]
}
