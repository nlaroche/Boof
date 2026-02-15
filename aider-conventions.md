# Aider Conventions for Boof

You are working on a React 18 + TypeScript + Vite PWA with a Node.js Express backend. Follow these rules strictly.

## Architecture
- **Server**: `src/server/` — Node.js, Express, ws, node-pty, better-sqlite3
- **Client**: `src/client/` — React 18, TypeScript, Vite, Tailwind CSS, Zustand
- Server entry: `src/server/index.ts`
- Client entry: `src/client/main.tsx`
- Single-user personal tool — no auth, no multi-tenancy

## Server Structure
- `src/server/index.ts` — Express + WebSocket server + static file serving
- `src/server/db.ts` — SQLite setup + query helpers
- `src/server/pty-manager.ts` — PTY lifecycle management (node-pty)
- `src/server/summarizer.ts` — Claude API output summarization
- `src/server/ws-handler.ts` — WebSocket message routing
- `src/server/notifications.ts` — Web Push notification sender

## Client Structure
- `src/client/main.tsx` — Entry point
- `src/client/App.tsx` — Root layout + bottom nav + WebSocket provider
- `src/client/hooks/` — useWebSocket, useSpeech, useNotifications, useHaptic
- `src/client/stores/store.ts` — Zustand store (single source of truth)
- `src/client/screens/` — HomeScreen, TasksScreen, AgentScreen, AgentsScreen, HistoryScreen
- `src/client/components/` — Reusable UI components
- `src/client/lib/` — types.ts, ansi.ts, format.ts

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
- Font: JetBrains Mono for terminal, Inter for UI
- Border radius: 12px cards, 8px buttons

## File Rules
- NEVER modify `package.json` scripts (they work as-is)
- NEVER modify `vite.config.ts` unless explicitly told to
- NEVER modify `tailwind.config.ts` unless explicitly told to
- NEVER add new dependencies without being explicitly told to
- All state flows through Zustand store, hydrated via WebSocket

## Build
- The build must pass: `vite build` (runs automatically via test command)
- Fix any build errors before finishing
- Do not introduce unused imports or variables
- Server code uses tsx for dev, compiles to JS for production

## WebSocket Protocol
- All client-server communication over a single WebSocket
- Messages are JSON with a `type` field
- Client sends: task:*, folder:*, agent:*, sync:request
- Server sends: sync:state, agent:output, agent:status, agent:summary, task:updated, folder:updated, notify
