# Aider Conventions for Boof

You are an AI coding assistant running inside Aider. You MUST edit files directly using Aider's edit format. Do NOT output tool calls, function calls, XML tags, or any other format — just provide the file edits. You have the files loaded in chat — edit them directly.

You are working on a React 19 + TypeScript + Vite PWA with a Node.js Express 5 backend. Follow these rules strictly.

## Architecture
- **Server**: `src/server/` — Node.js, Express 5, ws, node-pty, sql.js
- **Client**: `src/client/` — React 19, TypeScript, Vite, Tailwind CSS, Zustand
- Server entry: `src/server/index.ts`
- Client entry: `src/client/main.tsx`
- Single-user personal tool — no auth, no multi-tenancy

## Server Structure
- `src/server/index.ts` — Express + WebSocket server + static file serving
- `src/server/db.ts` — SQLite setup + query helpers (uses sql.js, NOT better-sqlite3)
- `src/server/pty-manager.ts` — PTY lifecycle management (node-pty, Aider only)
- `src/server/ws-handler.ts` — WebSocket message routing
- `src/server/autopilot.ts` — Autonomous agent loop
- `src/server/scheduler.ts` — Cron-based agent scheduling

## Client Structure
- `src/client/main.tsx` — Entry point
- `src/client/App.tsx` — Root layout + bottom nav + WebSocket provider
- `src/client/hooks/` — useWebSocket, useSpeech
- `src/client/stores/store.ts` — Zustand store (single source of truth)
- `src/client/screens/` — HomeScreen, TasksScreen, AgentScreen, AgentsScreen, GoalsScreen, HistoryScreen
- `src/client/components/` — Reusable UI components
- `src/client/lib/types.ts` — ALL TypeScript types and WS message type unions

## CRITICAL: Types
- ALL WebSocket message types are defined in `src/client/lib/types.ts`
- `WSClientMessage` = union of all client→server messages
- `WSServerMessage` = union of all server→client messages
- When adding new WS message types, you MUST update BOTH unions in types.ts
- The server tsconfig (`tsconfig.server.json`) compiles types.ts to `dist/server/`. The client tsconfig references these. If you change types.ts, the compiled output in dist/server/ will be rebuilt by test.ps1.

## Code Style
- TypeScript only (strict mode)
- ES modules (`import`/`export`)
- React functional components with hooks
- Tailwind CSS for styling (no CSS files)
- Keep functions small and focused
- No unnecessary comments or docstrings

## Design Rules
- Dark theme only. Near-black backgrounds (#0a0a0f, #14141f)
- Primary accent: #7c5bf5 (purple)
- Mobile-first. Bottom navigation. Large touch targets (min 48px)
- Border radius: 12px cards, 8px buttons

## File Rules
- NEVER modify `package.json` scripts
- NEVER modify `vite.config.ts` unless explicitly told to
- NEVER modify `tailwind.config.ts` unless explicitly told to
- NEVER add new dependencies without being explicitly told to
- All state flows through Zustand store, hydrated via WebSocket

## Build & Validation
- After making changes, run: `powershell -ExecutionPolicy Bypass -File test.ps1 -Quick`
- This runs vite build, TypeScript type checking, AND ESLint
- ESLint catches React hooks bugs (missing deps, closure issues) — fix ALL errors
- Pay special attention to `react-hooks/exhaustive-deps` warnings — they often indicate real bugs
- Fix ALL errors before finishing — do not leave broken code
- Do not introduce unused imports or variables

## Searching the Codebase
- You CAN run shell commands to search. Use `/run` followed by the command.
- To find where something is defined: `/run git grep -n "functionName" -- "*.ts" "*.tsx"`
- To find all usages of a type: `/run git grep -n "TypeName" -- "*.ts" "*.tsx"`
- To see a file's contents: `/run cat src/client/lib/types.ts`
- To find files by name: `/run git ls-files | grep -i "keyword"`
- To check what changed: `/run git diff --stat`
- ALWAYS search before guessing. If you need to know where something is defined or used, search first.
- The SEARCH CONTEXT block appended to your prompt contains auto-generated grep results — use them.

## Self-Improvement
- If you encounter a recurring error pattern, add a note to this file so you avoid it next time
- If a build/type error reveals a missing type definition, fix it in types.ts
