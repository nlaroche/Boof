# Boof — Project Instructions

Personal PWA + Node server for running autonomous coding agents against goals, controlled from a phone. Agents plan tasks, work in git branches/worktrees on autopilot, and a merge-gate pipeline consolidates → reviews → tests → merges their work.

## CRITICAL: Stop the Server Before Editing Code
The dev server (Vite HMR + autopilot) watches files and can revert or stomp edits, and autopilot runs `git checkout` which destroys uncommitted changes.
1. Check: `powershell -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 3456 -ErrorAction SilentlyContinue"`
2. Kill it before editing, commit before restarting. Never start the server with uncommitted edits.

## Stack
- Server: Node.js, Express 5, ws, node-pty, sql.js, tsx
- Client: React 19, TypeScript, Vite, Tailwind CSS, Zustand, vite-plugin-pwa

## Key Rules
- Single-user personal tool. No auth, no multi-tenancy.
- Dark theme only. Mobile-first. Bottom navigation.
- All state flows through Zustand store, hydrated via WebSocket.
- Keep it simple. No over-engineering.

## Running
- `npm run dev` — starts server (:3456) + Vite dev (:5173)
- `npm run build && npm start` — production
- Tests: `node --import tsx --test src/server/engine/__tests__/*.test.ts src/server/__tests__/*.test.ts`

## Architecture & Standards
- **Read first:** `docs/ARCHITECTURE.md` — full system design, all modules, data flow
- **Code rules:** `docs/CODE-STANDARDS.md` — file size limits, where code goes, error handling
- **Known bugs:** `docs/KNOWN-ISSUES.md` — ranked open defects from the 2026-07 full review; check before "fixing" adjacent code
- **Roadmap:** `docs/PRODUCT-VISION.md` — build priorities. `BOOF_SPEC.md` and `docs/ENGINE-IMPROVEMENTS.md` are historical.
- State machines for all lifecycles (`machines/`)
- Focused systems in `systems/` — one concern each
- All CRUD through `db-helpers.ts` patterns
- No magic strings — import from `engine/constants.ts`
- Prompts in `systems/prompt-builder.ts` — not inline in autopilot

## Windows Environment Notes
- `node` is NOT in system PATH for `cmd.exe` subprocesses
- `npm install --ignore-scripts` (then `node node_modules/esbuild/install.js`)
- Use `node node_modules/tsx/dist/cli.mjs` to run tsx (not `npx tsx`)
- Express 5: `/{*path}` for wildcard routes (NOT `*`)
- sql.js (not better-sqlite3) — avoids native compilation
- `powershell -ExecutionPolicy Bypass -Command` for PS from bash

## Production Deployment (Mac Mini)
```bash
git push origin main
bash scripts/deploy-mac-mini.sh
```
- Service: `com.nlaroche.boof` (launchd), port 3456
- Repo: `~/projects/boof`, Node: `~/.nvm/versions/node/v22.22.2/bin/node`
- Logs: `~/projects/boof/logs/boof.log`
- `npm install` needs `--legacy-peer-deps` (tsx/vite peer conflicts)
- See `scripts/deploy-mac-mini.sh` for full deploy flow
