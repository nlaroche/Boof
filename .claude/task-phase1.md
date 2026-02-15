Build the complete server foundation. Create these files:

1. src/server/db.ts - SQLite database using sql.js (NOT better-sqlite3). Initialize the database with the schema from BOOF_SPEC.md (folders, tasks, agents, commands tables). Export helper functions: initDb(), runQuery(), getOne(), getAll(). The DB should save to disk at DB_PATH from env (default ./boof.db). Use CREATE TABLE IF NOT EXISTS. sql.js is async for init - use initSqlJs() to load the WASM. After init, operations are synchronous. Save to disk after every mutation using fs.writeFileSync with Buffer.from(db.export()).

2. src/server/ws-handler.ts - WebSocket message handler. Import ws library. Handle all client message types from the spec (task:create, task:update, task:delete, folder:create, folder:update, folder:delete, agent:create, agent:kill, agent:send, agent:interrupt, sync:request, agent:history). Implement full CRUD for tasks and folders (read/write to SQLite). Agent operations can be stubs that log for now. On sync:request, send back full state (all folders, tasks, agents). Broadcast updates to all connected clients.

3. Update src/server/index.ts - Full Express server with:
   - Serve static files from dist/client
   - WebSocket server on the same HTTP server using ws
   - Load env vars from process.env
   - SPA fallback for client-side routing
   - Listen on PORT from env (default 3456)
   - Pass WebSocket connections to ws-handler
   - Initialize the database on startup

IMPORTANT: Use 'sql.js' package (already installed), NOT 'better-sqlite3'. For sql.js: import initSqlJs from 'sql.js'. Call const SQL = await initSqlJs(). Then new SQL.Database() or new SQL.Database(buffer) to load existing. db.run(sql, params) for mutations, db.exec(sql) for queries that return results. Use stmt = db.prepare(sql); stmt.bind(params); results while stmt.step() { stmt.getAsObject() }. Save with fs.writeFileSync(path, Buffer.from(db.export())).

Make sure all TypeScript types are correct and imports work.
