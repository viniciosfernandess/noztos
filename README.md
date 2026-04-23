This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

---

## Scale checklist (revisit at ~500 concurrent users)

Everything below is intentionally deferred. The current design is correct and
fast for single-instance deployment. These items unlock horizontal scale or
harden edge cases that don't matter yet.

### Persistence pipeline (`lib/companion-relay.ts`, `lib/chat-persist.ts`)

- [ ] **Ring buffer → Redis.** The per-session ring buffer lives in Node RAM
      today (pinned via `globalThis`). With 2+ server instances behind a load
      balancer, a session opened on instance A misses the buffer populated on
      instance B. Move `sessionBuffers` to Redis Hash (key = sessionId,
      TTL 24h). The `getSessionBuffer` / `dropSessionBuffer` interface already
      matches; just swap the backing store.
- [ ] **Relay channels → Redis pub/sub.** Same story for the `channels` Map.
      Today a daemon connected to instance A can't relay to a browser on
      instance B. Redis pub/sub per user id keeps horizontal scale honest.
- [ ] **Advisory-lock contention.** `pg_advisory_xact_lock(hashtextextended(sessionId))`
      serialises write-through + sync-messages for the same session. Fine at
      normal chat cadence, starts to bite if the same chat gets 10+ QPS of
      persist traffic. If that ever shows up in metrics, switch rollup to a
      background aggregate (below) and drop the lock.
- [ ] **Rollup drift (increment → aggregate).** `totalCostUsd`, `totalTokens`,
      `numTurns` are maintained via `{ increment }` inside `persistRows`.
      Works, but a missed increment (crash between upsert and rollup) drifts
      forever. At scale, run a periodic `SUM(costUsd)` query per session and
      overwrite the rollup columns. Same pattern for `lastMessageAt`.
- [ ] **SQLite queue ceiling on the daemon.** `~/.bornastar/queue.db` grows
      unbounded if the daemon stays offline for weeks. Add a max-age cap
      (e.g. drop `synced` rows older than 7d in `vacuumSynced`, and a hard
      ceiling on `pending` rows — oldest evicted + user warned).

### Auth & Realtime (`app/api/realtime-token/route.ts`)

- [ ] **Hand-rolled HS256 → `jose`.** The JWT signer in `realtime-token` is
      ~15 lines of `node:crypto`. Swap to `jose` when we need JWKS rotation or
      ES256 — `jose` also gives us the `jwtVerify` helper for free if a future
      feature needs to verify our own tokens elsewhere.
- [ ] **JWT revocation list.** `/api/realtime-token` mints a token valid for
      1h with no kill switch. If we ban a user, they keep streaming their own
      chat via Realtime until the token expires. Fine today; add a
      `jti` + Redis denylist when user moderation becomes a thing.
- [ ] **`DATABASE_URL` must use a BYPASSRLS role.** The migration
      `20260423000000_enable_realtime_and_rls` enables RLS on `chat_messages`
      and `chat_sessions`. Prisma reads/writes assume a superuser connection
      (Supabase's default `postgres` user is `BYPASSRLS`). If someone ever
      swaps to a scoped role, every Prisma query suddenly returns zero rows.
      Enforce this invariant in a deploy-time check.

### UX gaps

- [ ] **Reading archived / trashed chats.** `/api/projects/…/messages` rejects
      non-`open` sessions with 404, and `/api/companion/session-state` returns
      `{source: 'stale'}` for them. Today the UI just doesn't surface
      individual archived chats. When we add an "archived chats" drawer with
      scroll-through, we need a read endpoint that allows non-open status but
      marks the chat as read-only.
- [ ] **Ring buffer shows partial history on short conversations.** After a
      server restart the buffer starts empty. A mid-session chat shows only
      events since the restart until the user scrolls up (which falls through
      to `/messages`). Acceptable for MVP; consider pre-warming the buffer
      with the last page of `/messages` on first access.

### Observability

- [ ] **Prometheus / OpenTelemetry.** `/api/admin/metrics` is a poll endpoint
      that fetches live counters. Good for a human sanity-check, not good for
      alerting. Wire a real metrics pipeline (histograms for write-through
      latency, gauges for buffer size, counters for LRU evictions).
- [ ] **Structured logs.** The console.log statements today are human-readable
      strings. Switch to JSON logs (`{level, component, sessionId, …}`) so we
      can actually query them in a log aggregator.

### Misc

- [ ] **Daemon `bridge.on('done')` system row is redundant.** The CLI's own
      `result` event already persists a system row with `claudeSessionId`;
      the `done` handler adds a second empty one as a crash-recovery fallback.
      Once we have confidence the `result` event always arrives, drop it.
- [ ] **Write-through serialises per frame.** `after()` awaits each frame's
      write-through in sequence. Not a hot path (usually 1 frame per
      request), but if the daemon ever batches heavily, switch to
      `Promise.all(frames.map(writeThrough))` — the advisory lock still makes
      this race-free.
