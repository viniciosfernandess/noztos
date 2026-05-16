# bornastar — Architecture

This document captures the **load-bearing** design decisions for bornastar. It's the source of truth for build order and integration patterns. When something here is wrong, fix here first, then the code.

---

## Cloud Mirror — local↔cloud continuity

### Goal

User works locally with their Claude Code OAuth (zero token cost). When local connection dies, user can click "Continuar na nuvem" from any device (phone, second laptop) and continue from the **exact** state — same branch, same commit, uncommitted edits, untracked files, chat history, workflows. Bit-perfect.

When local recovers, click again to come back. Cloud-side work syncs down to local. Next claude session resumes with a summary of what cloud did.

### Non-goals

- Real-time collaborative editing (one user at a time per worktree)
- Mirroring the user's full local filesystem outside the worktree
- Replacing the user's GitHub remote — we coexist with it, don't depend on it

### Hard constraints

1. **Same architecture for every pricing tier.** Free, PAYG, $10/mo — same code path. The only thing pricing controls is whether the "switch to cloud" button is enabled.
2. **Zero extra infra cost while user is on local.** All mirror data fits in normal Postgres (which we already pay for). No R2, no separate KMS deployment beyond the one master key, no parallel storage.
3. **Real cost only when user activates cloud.** Tokens via our Anthropic API key + E2B sandbox time. Debited from credits or plan allowance.
4. **Per-worktree isolation.** One sandbox per worktree. User can have worktree A on local and worktree B on cloud simultaneously.
5. **Enterprise-grade security.** Per-user encryption keys wrapped by a KMS master, Row-Level Security in Postgres, audit logs on internal access, right-to-erasure via key revocation.
6. **Non-breaking on every change.** Additive only — zero ALTER on existing tables, zero changes to existing endpoints, feature-flagged.

### The pattern: shadow git, content-addressed

We mirror what the user's worktree contains in the same shape git uses internally: content-addressed blobs (deduped by SHA-256 of plaintext), path→hash entries, and patches for unpushed commits. We do not mirror the full `.git/objects/` history — only what's needed to reconstruct the working tree at cloud-activation time, plus enough metadata to preserve uncommitted work.

This is why it's cheap: in a typical worktree, 99% of files are identical to what's already in the user's other worktrees (same base branch). Content-addressing means **one blob row per unique file**, regardless of how many worktrees reference it.

### Data model (4 new tables — zero ALTER on existing)

```prisma
model GitObject {
  hash       String   @id              // SHA-256 of plaintext
  userId     String                    // dedup scope: only within this user
  content    Bytes                     // gzipped, then encrypted (Nível 2)
  sizeBytes  Int
  refCount   Int      @default(0)      // entries pointing to this blob — for GC
  createdAt  DateTime @default(now())

  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([refCount])  // GC scan
}

model WorktreeMirror {
  worktreeId        String   @id
  currentBranch     String
  currentCommitSha  String
  treeRootHash      String
  lastSyncAt        DateTime @default(now())
  totalSizeBytes    BigInt   @default(0)
  fileCount         Int      @default(0)

  worktree          Worktree @relation(fields: [worktreeId], references: [id], onDelete: Cascade)
}

model WorktreeFileEntry {
  id          String   @id @default(cuid())
  worktreeId  String
  path        String
  hash        String                    // FK to GitObject.hash
  mode        Int                       // file mode + executable bit
  status      String                    // 'tracked' | 'untracked' | 'modified'
  syncedAt    DateTime @default(now())

  worktree    Worktree @relation(fields: [worktreeId], references: [id], onDelete: Cascade)

  @@unique([worktreeId, path])
  @@index([worktreeId])
  @@index([hash])  // GC: when entry deleted, decrement GitObject.refCount
}

model UnpushedCommit {
  id            String   @id @default(cuid())
  worktreeId    String
  commitSha     String
  parentSha     String
  message       String
  authorName    String
  authorEmail   String
  authorDate    DateTime
  patchContent  Bytes                  // git format-patch output, gzipped+encrypted
  orderIndex    Int                    // chronological order for replay

  worktree      Worktree @relation(fields: [worktreeId], references: [id], onDelete: Cascade)

  @@unique([worktreeId, commitSha])
  @@index([worktreeId, orderIndex])
}

model UserEncryptionKey {
  userId       String   @id
  wrappedKey   Bytes                   // user's data key, encrypted by master KMS key
  kmsKeyId     String                  // which master key wrapped this
  createdAt    DateTime @default(now())
  revokedAt    DateTime?               // right-to-erasure trigger

  user         User @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

Existing tables get **no schema changes**. `Worktree` gets a new optional relation to `WorktreeMirror`, but that's a back-reference declaration only, no column added.

### Daemon hooks — 5 integration points with existing code

All async, fire-and-forget, never blocks user-facing operations.

| # | Trigger | Existing entry point | Mirror action |
|---|---|---|---|
| 1 | Worktree created | `provisionWorktree()` post-`git worktree add` (lib/worktree.ts ~303) | Walk `git ls-tree -r HEAD`, batch-check hashes against `GitObject` (dedup hit ~99% from `RepoFile` cache), upload missing blobs, insert `WorktreeFileEntry` rows |
| 2 | Claude Edit/Write tool | Daemon's tool_result handler (same hook that updates `taskTouchedPaths`) | Hash modified file, check if `GitObject` exists, upload if not, upsert `WorktreeFileEntry` |
| 3 | Manual file edit | `chokidar` watcher on worktree root (respects .gitignore, debounce 2s) | Same flow as #2 |
| 4 | `git fetch origin main` | Post-fetch in `refresh-main` and `advance-base` endpoints | Walk new main blobs, populate `GitObject` so future worktrees dedup against them |
| 5 | Local commit / push | Daemon git wrapper after `git commit` / detection of pushed range | For new local commits: `git format-patch` → insert `UnpushedCommit`. For pushed commits: delete corresponding `UnpushedCommit` rows |

### Cloud activation flow

```
User clicks "Continuar na nuvem":
  1. POST /api/cloud/switch?worktreeId=X
  2. Server checks: cloudEnabled (MVP) OR credit balance (post-billing)
  3. Server provisions E2B sandbox (1 per worktree)
  4. Server returns sandbox connection info to UI
  5. Sandbox runs init script:
     a. mkdir /workspace; cd /workspace; git init
     b. GET /api/cloud/materialize?worktreeId=X
        → returns: { branch, commitSha, files: [{ path, hash, mode }], unpushedCommits: [...] }
     c. For each file entry: GET /api/cloud/blob/{hash} → decrypt → write to path → chmod
     d. git add -A && git commit -m "[bornastar mirror snapshot]"
     e. For each unpushedCommit in order: git am < patch (recreates history)
     f. Reset HEAD to currentCommitSha
     g. Verify: for each file, recompute SHA-256, compare with WorktreeFileEntry.hash.
        Mismatch → fail loud with diagnostic, do not proceed with corrupted state.
     h. Start claude-cli with ANTHROPIC_API_KEY=$BORNASTAR_KEY
  6. SSE relay flips: chat now talks to sandbox instead of local daemon
  7. UI shows badge "☁ cloud"
```

Total wall-clock: ~10-15s for medium repo, up to ~30s for very large.

### Cloud → local return

```
User clicks "Voltar pro local":
  1. Cloud sandbox runs sync-down: walks FS, uploads any blob with new hash, updates WorktreeFileEntry
  2. Daemon (local, online again) receives signal
  3. Daemon compares disk vs DB → downloads blobs with new hashes → atomic write (tmp + rename)
  4. Resume local claude:
     - claude --resume <sessionId>
     - Server prepends to next user message: "[Continuação após sessão no cloud]: enquanto offline, fiz [summary]. Filesystem sincronizado."
  5. Sandbox marked for GC (10 min idle → destroyed)
```

### Lifecycle / cascade

- **Worktree deleted** → cascades to `WorktreeMirror`, `WorktreeFileEntry`, `UnpushedCommit` for that worktree. Each `WorktreeFileEntry` deletion decrements `GitObject.refCount`.
- **Project deleted** → cascades to worktrees → cascades to mirror entries.
- **User cancels account** → `UserEncryptionKey.revokedAt = now()`. All blobs immediately unreadable. Hard-delete background job purges rows after 7-day grace.
- **GC of orphan blobs** — nightly job: `DELETE FROM GitObject WHERE refCount = 0 AND createdAt < now() - interval '24 hours'`.
- **Soft-delete grace** — all deletes mark `deletedAt` first; hard delete after 7 days for recovery.

### Security — 7 layers

1. **Postgres encryption-at-rest** (Supabase native, AES-256, automatic)
2. **App-level encryption per user** — `GitObject.content` and `UnpushedCommit.patchContent` are encrypted with a per-user key derived via HKDF from a KMS master. Engineer with DB access sees ciphertext.
3. **KMS-wrapped user keys** — `UserEncryptionKey.wrappedKey` holds the user's key encrypted by master. Master never leaves KMS. Decrypt requires IAM + 2FA + audit log.
4. **Row-Level Security** in Postgres — policies on `GitObject`, `WorktreeMirror`, `WorktreeFileEntry`, `UnpushedCommit` enforce `userId = auth.uid()` filtering. App bug doesn't bypass.
5. **Integrity verification by hash** — `GitObject.hash` is SHA-256 of plaintext; recomputed at materialize time. Tampering detected before sandbox proceeds.
6. **Audit log** — internal queries to KMS and to encrypted tables logged (Supabase Logflare).
7. **TLS in transit** — daemon↔server, sandbox↔server, all HTTPS. Postgres SSL forced.

Compromising the user's source code requires breaching Postgres + KMS + audit bypass concurrently, all 2FA-gated.

### Cost model

Per user, typical: ~12 MB after gzip + encryption, with dedup across worktrees. Scales as:

| Users | Storage | Tier |
|---|---|---|
| 10K | ~120 GB | Supabase normal |
| 100K | ~1.2 TB | Supabase Pro |
| 1M | ~12 TB | Same curve, linear |

This is "DB growth" — same cost center as chat messages already growing per user. No new infrastructure line item.

Active cost only when user clicks "switch to cloud":
- Anthropic API tokens via our key (debited from credits / plan allowance)
- E2B sandbox uptime (debited from credits / plan allowance)

### Non-breaking guarantees

All work follows these rules. Violating them requires explicit user approval:

1. **Schema additions only** — no `ALTER` on tables that exist today. Only `CREATE TABLE`.
2. **No changes to existing endpoints** — new endpoints under `/api/companion/mirror/*` and `/api/cloud/*` only.
3. **No changes to existing daemon behavior** — mirror hooks are listeners that observe existing events, never replace.
4. **Feature flag from day 1** — `MIRROR_ENABLED` env var defaults to false. Mirror code is dead until flipped.
5. **User-level gate for cloud switch** — `User.cloudEnabled` boolean (MVP). UI hides button if false. Endpoint returns 403 if false. Post-billing this becomes a credit/plan check.
6. **Async fire-and-forget hooks** — any error in mirror code is caught and logged, never bubbles to user-facing flow.
7. **Migrations reversible** — every Prisma migration has a tested rollback path.

### Build order (becomes Linear tasks)

Each item is one Linear task. Each task follows the `CLAUDE.md` loop: CEO → Architect → Builder → Security.

#### Phase 1 — Mirror infrastructure (invisible)
1. Schema: `GitObject` table + migration + RLS policy
2. Schema: `WorktreeMirror` table + migration + RLS policy
3. Schema: `WorktreeFileEntry` table + migration + RLS policy
4. Schema: `UnpushedCommit` table + migration + RLS policy
5. Schema: `UserEncryptionKey` table + migration + RLS policy
6. Encryption module: `lib/mirror/crypto.ts` — KMS master + per-user key derivation + encrypt/decrypt with AES-256-GCM
7. Server API: `POST /api/companion/mirror/check-hashes` (batch dedup check)
8. Server API: `POST /api/companion/mirror/upload` (blob upload with hash + auth)
9. Server API: `POST /api/companion/mirror/commit-entries` (upsert WorktreeFileEntry batch)
10. Server API: `POST /api/companion/mirror/unpushed` (insert UnpushedCommit)

#### Phase 2 — Daemon hooks
11. Hook: `provisionWorktree()` post-success → initial mirror walk + upload
12. Hook: Claude tool_result handler → mirror modified files
13. Hook: chokidar file watcher on worktree root (respects .gitignore, debounce 2s)
14. Hook: `refresh-main` / `advance-base` post-fetch → populate GitObject from new blobs
15. Hook: commit/push detection → manage UnpushedCommit rows

#### Phase 3 — Cloud activation
16. Server API: `POST /api/cloud/switch` — provisions E2B sandbox per worktree
17. Server API: `GET /api/cloud/materialize` — returns reconstruction manifest
18. Server API: `GET /api/cloud/blob/:hash` — serves decrypted blob to authorized sandbox
19. Sandbox init script — clone-from-mirror + verify by hash + start claude-cli
20. SSE relay flip — route chat events to sandbox connection instead of companion

#### Phase 4 — UI
21. Worktree top-bar badge "☁ off / on / offline"
22. "Switch to cloud" modal + progress UI
23. "Back to local" flow + sync-down progress

#### Phase 5 — Lifecycle + GC
24. GC job: orphan `GitObject` rows (refCount=0, >24h old)
25. Soft-delete grace period + 7-day hard-delete background job
26. Right-to-erasure: revoke `UserEncryptionKey` on account deletion

#### Phase 6 — Pricing (deferred until 1-5 are validated)
27. `CreditBalance` + `CreditTransaction` models
28. Stripe integration: buy credits + $10/mo subscription
29. Replace `User.cloudEnabled` boolean with credit/plan check
30. Billing dashboard
31. Token + sandbox-time usage tracking → automatic debit
