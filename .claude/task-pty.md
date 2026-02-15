Create src/server/pty-manager.ts - PTY lifecycle manager for Claude Code processes.

Use the 'node-pty' package (already installed). This manages multiple Claude Code CLI sessions.

Exports:
- createAgent(id, workingDirectory, name, onOutput, onExit): spawns 'claude' CLI via node-pty in the given directory. Store the pty instance keyed by agent id. When data comes from pty, call onOutput(id, chunk). When process exits, call onExit(id).
- sendToAgent(id, text): write text + newline to the pty
- interruptAgent(id): send SIGINT to the pty (write '\x03')
- killAgent(id): kill the pty process
- restartAgent(id, workingDirectory, name, onOutput, onExit): kill then create
- getAgentPid(id): return the pid

Use a Map<string, IPty> to store active ptys. Spawn with shell: false, use 'claude' as the command. Set cols: 120, rows: 40.

On Windows, the shell should be 'cmd.exe' with args ['/c', 'claude']. On other platforms, just 'claude'.

Also update src/server/ws-handler.ts to wire up the agent operations:
- agent:create -> call createAgent, insert into DB, broadcast agent:status
- agent:kill -> call killAgent, update DB status to 'dead', broadcast
- agent:restart -> call restartAgent
- agent:send -> call sendToAgent, update DB status to 'running', insert command into DB
- agent:interrupt -> call interruptAgent
- agent:output callback -> broadcast to all clients
- agent:exit callback -> update status to 'idle' or 'dead', broadcast

Import node-pty as: import * as pty from 'node-pty'
