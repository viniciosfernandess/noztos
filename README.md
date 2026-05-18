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

```bash
npm run dev
```

That's it. Both the Next.js web UI and the companion daemon spawn in parallel — the daemon authenticates automatically via a shared secret in `./data/.companion-secret`.

Open [http://localhost:3000](http://localhost:3000), sign up, you land on the dashboard with the companion already connected.

## Requirements

- Node ≥ 18
- [Claude Code](https://claude.ai/install) installed and signed in (`claude` in your PATH)
- Postgres database

## Mobile

Want to use it from your phone? Expose `localhost:3000` via a tunnel:

```bash
cloudflared tunnel --url localhost:3000
```

Or set up [Tailscale](https://tailscale.com) for a private VPN between your Mac and phone.

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
