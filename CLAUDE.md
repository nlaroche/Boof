# Boof — Project Instructions

This is a personal PWA + Node server for controlling Claude Code from a phone.

## Stack
- Server: Node.js, Express 5, ws, node-pty, sql.js, tsx
- Client: React 19, TypeScript, Vite, Tailwind CSS, Zustand, vite-plugin-pwa

## Key Rules
- This is a single-user personal tool. No auth, no multi-tenancy.
- Dark theme only. Colors defined in tailwind.config.ts.
- Mobile-first. Everything must be thumb-friendly.
- Bottom navigation, not top.
- All state flows through Zustand store, hydrated via WebSocket.
- Terminal output must preserve ANSI colors.
- Keep it simple. No over-engineering.

## Running
- `npm run dev` starts both server and client
- Server on :3456, Vite dev on :5173 (proxied)
- `npm run build && npm start` for production

## Database
- SQLite at ./boof.db
- Schema in src/server/db.ts
- Migrations are just CREATE IF NOT EXISTS (it's personal, keep it simple)

## Windows Environment Notes
- This runs on Windows (MSYS/Git Bash). Use Unix shell syntax in bash.
- `node` is NOT in the system PATH for `cmd.exe` subprocesses.
- npm postinstall scripts often fail — use `npm install --ignore-scripts` as fallback.
- Use `node node_modules/tsx/dist/cli.mjs` to run tsx (not `npx tsx`).
- Use `node node_modules/.bin/<tool>` if a locally installed npm binary isn't found.
- Express 5 uses `/{*path}` for wildcard routes (NOT `*`).
- sql.js is used instead of better-sqlite3 to avoid native compilation issues.
- Static files are served from `dist/client`, resolved via `process.cwd()` (not `__dirname`).
- Use `powershell -ExecutionPolicy Bypass -Command` for PowerShell commands from bash.

## Architecture (REQUIRED READING)
See `ARCHITECTURE.md` for the full engine design. Key rules:
- **State machines** for all entity lifecycles (agent, goal, task, command, autopilot)
- **Utility scoring** for task/goal selection (not dumb rotation)
- **No magic strings** — import from `src/server/engine/constants.ts`
- **No inline SQL in handlers** — use `src/server/db-helpers.ts` CRUD functions
- **Test every machine** with `validateMachineDefinition()` + transition tests
- Machine definitions in `src/server/machines/`
- Focused systems in `src/server/systems/`
- Run tests: `npm run test:unit` (includes engine tests)

## Aider Orchestration
- `aider-task.ps1` — Send tasks to Aider with conventions prepended
- `aider-fix.ps1` — Emergency build fixer (max 3 attempts)
- `aider-iterate.ps1` — Autonomous build-fix loop (max 5 attempts)
- `test.ps1` — Build validation (use -Quick for build-only)
- `aider-conventions.md` — Rules Aider must follow
