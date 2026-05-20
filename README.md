# noztos

**A local-first web IDE for [Claude Code](https://claude.ai/claude-code).**

noztos turns Claude Code into a multi-agent workspace. Run several Claude
agents at once — each on its own branch, isolated in its own worktree,
working in parallel without stepping on each other. Hand bigger jobs to a
**workflow** (`/build`, `/debug`) — a chain of specialized agents that
runs end to end. Or queue up **tasks** and let agents pick them up on
their own.

> **Built for macOS.** Linux runs with a couple of tweaks; Windows
> needs WSL2.

![noztos](docs/desktop.png)

| Chat with your agents | Review diffs & open PRs |
| --- | --- |
| ![noztos on mobile — chat](docs/phone-chat.png) | ![noztos on mobile — changes](docs/phone-changes.png) |

---

## Install

### Before you start

- **Node ≥ 20.9** (required by Next.js 16)
- **[Claude Code](https://claude.ai/install)** installed and signed in —
  the `claude` command must be in your `PATH`
- A **Postgres** database (a free [Supabase](https://supabase.com)
  project is the easiest option)

**1. Clone the repo**

```bash
git clone https://github.com/Noztos-ai/noztos.git
cd noztos
cp .env.example .env
```

**2. Configure `.env`**

Open `.env` and set, at minimum:

- `DATABASE_URL` and `DIRECT_URL` — any Postgres works. The easiest path
  is a free [Supabase](https://supabase.com) project; paste its connection
  string into both.
- `NODE_SECRET` — generate one with `openssl rand -hex 32`.

Everything else in `.env` is optional (GitHub OAuth, email, Slack…) and
documented inline in `.env.example`.

**3. Install dependencies and set up the database**

```bash
npm install
npx prisma db push
```

**4. Run it**

```bash
npm run go
```

The first build takes ~60 seconds; it's incremental after that. When it's
ready, open **[http://localhost:3000](http://localhost:3000)**, sign up,
and you land on the dashboard with the companion already connected.

> Hacking on noztos itself? Use `npm run dev` instead — that gives you
> hot reload, source maps, and dev overlays. `npm run go` is the mode you
> want for daily use (and it's the only mode the phone-access tunnel
> works in).

**5. Enable phone access — optional**

Want to code from your phone? noztos can expose itself over a secure
tunnel so you can reach it from anywhere.

One-time setup on your machine:

```bash
brew install ngrok
# sign up free at https://dashboard.ngrok.com
ngrok config add-authtoken <YOUR_TOKEN>
```

Then click the **Phone access** button in the navbar. noztos spawns the
tunnel and shows a QR code — scan it, sign in with the same account, and
you're coding from anywhere. Anyone who opens the URL lands on your
sign-in page first, so your password is what protects access.

---

## Updating

`npm run go` runs whatever is on your disk — it doesn't pull. To move
to the latest version:

```bash
npm run update   # git pull + npm install + prisma db push
npm run go
```

`npm run update` is safe to run every time — `npm install` and
`prisma db push` are no-ops when nothing changed.

---

## How it works

noztos is **two processes**, both running on your machine:

```
Browser  ↔  Next.js (localhost:3000)  ↔  Companion daemon  ↔  claude CLI
                       ↓
                  Your projects on disk
```

1. **The web app** (`localhost:3000`) — the UI you see in the browser.
   It owns the database, the chat interface, and GitHub integration.
2. **The companion daemon** — a small local process that spawns the
   `claude` CLI for each chat, watches your files for changes, and
   streams everything back to the browser.

A few concepts that make it click:

- **Workspace** — each one is a real git worktree: an isolated branch
  with its own folder on disk. Agents in different workspaces never
  collide, so you can run many at once.
- **Chat** — a conversation with one Claude agent inside a workspace.
  A workspace can hold several chats working different angles of the
  same branch.
- **Workflow** — a pre-built chain of specialized agents. `/build`
  runs planner → architect → builder → reviewer; `/debug` adds
  parallel investigators. You describe the goal once and the chain
  runs itself.

That's it. No cloud, no accounts to manage, no infrastructure — just
your machine, your repos, and Claude Code working in parallel.

---

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). For anything
bigger than a bug fix, open an issue first so we agree on direction.

## License

[MIT](LICENSE).
