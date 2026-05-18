# CLAUDE.md — noztos

Instructions for Claude Code when working in this repository.

## Project layout

- `app/` — Next.js App Router. Routes and React server components.
- `components/` — Client-side React components.
- `lib/` — Server-side helpers (auth, db, compute, workflows).
- `companion/` — The local daemon. Separate Node package, separate `package.json`.
- `prisma/schema.prisma` — Database schema. Don't edit migrations by hand; run `npx prisma migrate dev --name <change>` to generate one.

## Architecture

Single-machine, local-first. Two processes on the user's Mac:

1. **Next.js server** (`npm run dev`, port 3000) — handles HTTP, the database, OAuth, the chat UI.
2. **Companion daemon** (`noztos start`) — spawns the local `claude` CLI per chat session, watches the filesystem, relays events to the server.

The server can fan out commands to the daemon via SSE (`/api/companion/events`). The daemon POSTs results back via `/api/companion/response`.

## Code conventions

- TypeScript strict mode. Avoid `any` — use `unknown` and narrow.
- Prefer editing existing files over creating new ones.
- No unsolicited comments. Only write a comment when *why* is non-obvious.
- Don't add features, refactors, or abstractions beyond what the task asks.
- Treat `lib/db.ts` as the single Prisma entry — don't `new PrismaClient()` elsewhere.

## When making changes

- Run `npx tsc --noEmit` to type-check before committing.
- Run `npm run build` if you touched routing, layouts, or Prisma models.
- Run `cd companion && npm run build` if you touched daemon code.

## When NOT to do something

- Don't introduce a cloud-hosted backend, server-side child_process against `/Users/...` paths, or anything that assumes Next.js runs anywhere other than the user's machine. The project is intentionally single-machine.
- Don't commit `.env`, `.claude/`, `generated/`, or `node_modules/`.
- Don't refactor working code just to "clean it up" without an asked reason.
