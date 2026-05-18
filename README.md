# noztos

A local-first, self-hosted IDE companion for [Claude Code](https://claude.ai/claude-code). Spin up isolated worktrees per task, chat with Claude inside each one, ship PRs from the browser.

Built around **two terminals**:

1. **Next.js web UI** running on `localhost:3000` — chat, file explorer, terminal, tasks, worktree management.
2. **Companion daemon** that bridges the web UI to the `claude` CLI running on your machine.

Both run on the same Mac (or Linux / Windows). No cloud server in the middle, no data leaves your machine except calls to the Anthropic API made by your local `claude` install.

---

## Setup

### Prereqs
- Node.js ≥ 18
- [Claude Code](https://claude.ai/install) installed and authenticated
- Postgres database (free [Supabase](https://supabase.com) project works fine)

### 1. Clone + install
```bash
git clone https://github.com/<your-fork>/noztos.git
cd noztos
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# edit .env — at minimum set DATABASE_URL, DIRECT_URL, NODE_SECRET
```

For OAuth (GitHub login + repo access), create an [OAuth app](https://github.com/settings/developers) with callback `http://localhost:3000/api/auth/github/callback` and fill in `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`.

### 3. Initialize the database
```bash
npx prisma migrate deploy
npx prisma generate
```

### 4. Install the companion daemon (global CLI)
```bash
cd companion
npm install
npm run build
npm install -g .
cd ..
```

### 5. Run

**Terminal 1** — web UI:
```bash
npm run dev
```

**Terminal 2** — companion daemon:
```bash
noztos login <token>     # generate a token at localhost:3000 once signed up
```

That's it. `noztos login` also installs a launchd agent on macOS so the daemon auto-starts on every login — no need to keep a terminal open after the first setup.

Open `http://localhost:3000`, sign up locally, and connect.

---

## Features

- **Worktrees** — every task runs in an isolated `git worktree` branch. Switch between them in the sidebar.
- **Workflows** — slash commands like `/build`, `/debug`, `/ship` that orchestrate multi-step Claude runs (CEO → architect → builder → reviewer).
- **Tasks** — Linear-style task forking inside a worktree. Cancel mid-run, see live transcripts.
- **Mini terminal** — interactive PTY per worktree.
- **File explorer** — read/write files inside the worktree from the browser.
- **GitHub PRs** — create PRs without leaving the app.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser (localhost:3000)                           │
│  React + Next.js                                    │
└───────────┬─────────────────────────────────────────┘
            │ HTTP + SSE
┌───────────▼─────────────────────────────────────────┐
│  Next.js server (this repo, port 3000)              │
│  - API routes, Prisma, auth                         │
│  - Spawns child_process for git / file ops          │
└───────────┬───────────────────┬─────────────────────┘
            │ SSE relay         │ child_process
┌───────────▼──────┐  ┌─────────▼──────────────────────┐
│  Companion       │  │  Local filesystem              │
│  daemon (CLI)    │  │  (your projects)               │
│  - Spawns claude │  │                                │
│  - Watches files │  │                                │
└──────────────────┘  └────────────────────────────────┘
```

Everything is **local**. The Next.js server and companion daemon both run on your machine.

## Mobile access

If you want to use the web UI from your phone, expose `localhost:3000` via a tunnel:

```bash
cloudflared tunnel --url localhost:3000
```

Or use [Tailscale](https://tailscale.com/) for a private VPN between your Mac and phone.

## License

MIT — see [LICENSE](LICENSE).

## Credits

Built on top of [Claude Code](https://claude.ai/claude-code). Inspired by [emdash](https://github.com/generalaction/emdash), [Conductor](https://conductor.build), and the broader local-first agent community.
