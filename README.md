# noztos

A local-first web IDE for [Claude Code](https://claude.ai/claude-code). Run multiple branches in parallel, ship PRs from your browser.

> Your code never leaves your machine. The only network call goes from your local `claude` CLI to the Anthropic API — same as running it in a terminal.

---

## What you can do

- Run multiple Claude Code sessions in isolated git worktrees, side by side
- Use built-in workflows (`/build`, `/debug`, `/ship`) for multi-step refactors
- See files, terminal, and chat in one window
- Create GitHub PRs from the UI without leaving

## Install

```bash
git clone https://github.com/Noztos-ai/noztos.git
cd noztos
cp .env.example .env
```

Edit `.env` and set at minimum:

- `DATABASE_URL` + `DIRECT_URL` — any Postgres works (free [Supabase](https://supabase.com) project is easiest)
- `NODE_SECRET` — run `openssl rand -hex 32`

Then:

```bash
npm install
npx prisma db push
```

## Run

Two ways, depending on what you're doing:

```bash
# Using noztos as your daily tool (recommended)
npm run go

# Hacking on noztos itself (HMR, source maps, dev overlays)
npm run dev
```

`npm run go` builds Next.js in production mode, then spawns both the
web server and the companion daemon. The build takes ~60 s the first
time and is incremental after that. Production bundles are an order
of magnitude smaller than dev mode, which is what makes the phone
access tunnel work — Next.js dev mode depends on a WebSocket for HMR
that most tunnel providers either don't support or buffer poorly.

After it's running, open [http://localhost:3000](http://localhost:3000), sign up, you land on the dashboard with the companion already connected.

## Requirements

- Node ≥ 18
- [Claude Code](https://claude.ai/install) installed and signed in (`claude` in your PATH)
- Postgres database

## Mobile / phone access

Click the **Phone access** button in the navbar — `npm run go` mode
spawns an ngrok tunnel and shows a QR code. Scan it from your phone,
log in with the same account, and you're coding from anywhere.

One-time setup on your machine:

```bash
brew install ngrok
# sign up free at https://dashboard.ngrok.com
ngrok config add-authtoken <YOUR_TOKEN>
```

Anyone with the URL sees your sign-in page. Your password protects access.

## Architecture

```
Browser  ↔  Next.js (localhost:3000)  ↔  Companion daemon  ↔  claude CLI
                       ↓
                  Your projects on disk
```

Two processes, both on your machine. No cloud server. No multi-tenant. Single user, single DB.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Open an issue before starting anything bigger than a bug fix so we agree on direction first.

## License

[MIT](LICENSE).

---

Built on top of [Claude Code](https://claude.ai/claude-code). Inspired by [emdash](https://github.com/generalaction/emdash) and [Conductor](https://conductor.build).
