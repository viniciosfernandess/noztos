#!/usr/bin/env bash
# Cloud Mirror — sandbox init script.
#
# Runs inside the E2B sandbox after provisioning. Reconstructs the
# user's worktree bit-perfect by pulling the manifest + blobs + patches
# from the bornastar server (using the sandbox session token), then
# starts the in-sandbox claude bridge so the user's chat continues
# inside this isolated VM.
#
# Required env vars (set by /api/cloud/switch when running the script):
#   BORNASTAR_SERVER_URL   — base URL of the bornastar API
#   BORNASTAR_SANDBOX_TOKEN — bearer token for cloud/* endpoints
#   BORNASTAR_WORKTREE_ID  — the worktree being materialized
#   ANTHROPIC_API_KEY      — used by claude-cli (Bornastar's key, billed)
#
# Exit codes:
#   0  — sandbox materialized + ready, claude bridge started
#   1  — environment misconfiguration
#   2  — manifest / blob fetch failure (mirror not ready or network error)
#   3  — integrity check failure (hash mismatch on materialized file)
#   4  — git replay failure (patch didn't apply cleanly)

set -euo pipefail

log() { echo "[sandbox-init] $*" >&2; }
fail() { log "FATAL: $*"; exit "${2:-1}"; }

[ -n "${BORNASTAR_SERVER_URL:-}" ]   || fail "BORNASTAR_SERVER_URL not set" 1
[ -n "${BORNASTAR_SANDBOX_TOKEN:-}" ] || fail "BORNASTAR_SANDBOX_TOKEN not set" 1
[ -n "${BORNASTAR_WORKTREE_ID:-}" ]   || fail "BORNASTAR_WORKTREE_ID not set" 1

WORKSPACE="/workspace"
MANIFEST="/tmp/manifest.json"
AUTH_HEADER="Authorization: Bearer ${BORNASTAR_SANDBOX_TOKEN}"

log "=== Bornastar sandbox init starting ==="
log "server=${BORNASTAR_SERVER_URL} worktree=${BORNASTAR_WORKTREE_ID} token=${BORNASTAR_SANDBOX_TOKEN:0:8}..."

# ── 0. Ensure tooling is present ────────────────────────────────────
# Base E2B template ships with curl + git + python + node. jq and
# claude-cli aren't always there. Install lazily so we don't need a
# custom template for the MVP — adds ~20s on first boot, fine for the
# first test. E2B sandboxes run as non-root `user` with passwordless
# sudo available, so apt + global npm install need the sudo prefix.
SUDO=""
if command -v sudo >/dev/null 2>&1 && [ "$(id -u)" != "0" ]; then
  SUDO="sudo"
fi
if ! command -v jq >/dev/null 2>&1; then
  log "installing jq..."
  $SUDO apt-get update -qq >/dev/null 2>&1 || true
  $SUDO apt-get install -y -qq jq >/dev/null 2>&1 || fail "jq install failed" 1
fi
if ! command -v claude >/dev/null 2>&1; then
  log "installing claude-cli (npm i -g @anthropic-ai/claude-code)..."
  # Global npm install needs root if npm's prefix is /usr/local. Fall
  # back to user-local install if global fails (rare on E2B base).
  if ! $SUDO npm install -g @anthropic-ai/claude-code >/dev/null 2>&1; then
    log "global install failed, trying user-local..."
    npm install -g --prefix "$HOME/.npm-global" @anthropic-ai/claude-code >/dev/null 2>&1 || fail "claude-cli install failed (npm)" 1
    export PATH="$HOME/.npm-global/bin:$PATH"
  fi
fi
log "tooling ready: jq=$(jq --version 2>/dev/null) git=$(git --version | awk '{print $3}') claude=$(claude --version 2>&1 | head -1) node=$(node --version)"

mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

# ── 1. Fetch manifest ───────────────────────────────────────────────
log "fetching manifest for worktree=${BORNASTAR_WORKTREE_ID}"
if ! curl -sfS -H "$AUTH_HEADER" \
    "${BORNASTAR_SERVER_URL}/api/cloud/materialize/${BORNASTAR_WORKTREE_ID}" \
    -o "$MANIFEST"; then
  fail "manifest fetch failed" 2
fi

BRANCH=$(jq -r '.branch' "$MANIFEST")
COMMIT=$(jq -r '.commit' "$MANIFEST")
FILE_COUNT=$(jq '.files | length' "$MANIFEST")
UNPUSHED_COUNT=$(jq '.unpushedCommits | length' "$MANIFEST")
log "manifest: branch=${BRANCH} commit=${COMMIT:0:8} files=${FILE_COUNT} unpushed=${UNPUSHED_COUNT}"

# ── 2. Initialise git in workspace ──────────────────────────────────
git init -q
git config user.email "sandbox@bornastar.com"
git config user.name "Bornastar Sandbox"
git checkout -q -b "${BRANCH}"

# ── 3. Materialise each blob → write file → chmod ───────────────────
log "materializing ${FILE_COUNT} files..."
jq -r '.files[] | "\(.hash) \(.mode) \(.path)"' "$MANIFEST" | while IFS=' ' read -r HASH MODE REL_PATH; do
  DEST="${WORKSPACE}/${REL_PATH}"
  mkdir -p "$(dirname "$DEST")"
  if ! curl -sfS -H "$AUTH_HEADER" \
      "${BORNASTAR_SERVER_URL}/api/cloud/blob/${HASH}" -o "$DEST"; then
    fail "blob fetch failed for hash=${HASH:0:8} path=${REL_PATH}" 2
  fi
  # Verify hash bit-by-bit before continuing — a corrupted file should
  # never reach the user's session silently.
  ACTUAL=$(sha256sum "$DEST" | awk '{print $1}')
  if [ "$ACTUAL" != "$HASH" ]; then
    fail "integrity FAIL path=${REL_PATH} expected=${HASH:0:8} got=${ACTUAL:0:8}" 3
  fi
  # File mode comes back as a base-10 int; mask to permission bits.
  chmod "$(printf '%o' $((MODE & 0o777)))" "$DEST"
done
log "all files materialized + verified"

# ── 4. Synthetic snapshot commit (so the next git commands have a HEAD) ─
git add -A
GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' \
GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' \
  git commit -q --allow-empty -m "[bornastar mirror snapshot]"

# ── 5. Replay unpushed commits via git am ───────────────────────────
if [ "$UNPUSHED_COUNT" -gt 0 ]; then
  log "replaying ${UNPUSHED_COUNT} unpushed commits..."
  jq -r '.unpushedCommits[] | .commitSha' "$MANIFEST" | while read -r SHA; do
    PATCH="/tmp/patch_${SHA:0:8}.mbox"
    if ! curl -sfS -H "$AUTH_HEADER" \
        "${BORNASTAR_SERVER_URL}/api/cloud/patch/${SHA}" -o "$PATCH"; then
      fail "patch fetch failed for ${SHA:0:8}" 2
    fi
    if ! git am --3way --quiet < "$PATCH"; then
      git am --abort 2>/dev/null || true
      fail "git am failed for ${SHA:0:8}" 4
    fi
  done
  log "all unpushed commits replayed"
fi

log "READY worktree=${BORNASTAR_WORKTREE_ID} branch=${BRANCH} commit=${COMMIT:0:8}"
# Marker file the server polls to confirm init.sh completed cleanly.
# Without this, the server can't distinguish "init still running" from
# "init crashed silently" (background: true swallows the exit code).
touch /tmp/bornastar-init-ready

# ── 6. Start the in-sandbox claude bridge ───────────────────────────
# The bridge is a small Node script (uploaded by /api/cloud/switch
# alongside this init) that polls the bornastar /api/companion/events
# stream for prompts targeted at this worktree, spawns claude-cli with
# them, and pipes the stream-json back via /api/companion/response.
# It uses the sandbox token for auth so the server can route only this
# worktree's messages to this sandbox.
if [ -f /sandbox/bridge.mjs ]; then
  log "starting claude bridge"
  exec node /sandbox/bridge.mjs
else
  log "bridge.mjs not found — sandbox staying alive idle"
  # Keep the process alive so E2B doesn't garbage-collect it before the
  # user actually starts chatting. The /api/cloud/switch caller can
  # send commands.run later.
  tail -f /dev/null
fi
