import * as pty from 'node-pty';
import type { IPty } from 'node-pty';

interface AgentCallbacks {
  onOutput: (id: string, chunk: string) => void;
  onExit: (id: string, code: number) => void;
}

const ptys: Map<string, IPty> = new Map();
const callbacks: Map<string, AgentCallbacks> = new Map();

const isWindows = process.platform === 'win32';

export function createAgent(
  id: string,
  workingDirectory: string,
  name: string,
  onOutput: (id: string, chunk: string) => void,
  onExit: (id: string, code: number) => void
): void {
  if (ptys.has(id)) {
    killAgent(id);
  }

  let shell: string;
  let args: string[];

  if (isWindows) {
    shell = 'cmd.exe';
    args = ['/c', 'claude'];
  } else {
    shell = 'claude';
    args = [];
  }

  const ptyProcess = pty.spawn(shell, args, {
    cwd: workingDirectory,
    cols: 120,
    rows: 40,
    shell: false,
    env: process.env as { [key: string]: string },
  });

  ptys.set(id, ptyProcess);
  callbacks.set(id, { onOutput, onExit });

  ptyProcess.onData((data) => {
    onOutput(id, data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    onExit(id, exitCode);
  });

  console.log(`Agent ${id} created with PID ${ptyProcess.pid}`);
}

export function sendToAgent(id: string, text: string): void {
  const ptyProcess = ptys.get(id);
  if (ptyProcess) {
    ptyProcess.write(text + '\n');
  }
}

export function interruptAgent(id: string): void {
  const ptyProcess = ptys.get(id);
  if (ptyProcess) {
    ptyProcess.write('\x03');
  }
}

export function killAgent(id: string): void {
  const ptyProcess = ptys.get(id);
  if (ptyProcess) {
    ptyProcess.kill();
    ptys.delete(id);
    callbacks.delete(id);
    console.log(`Agent ${id} killed`);
  }
}

export function restartAgent(
  id: string,
  workingDirectory: string,
  name: string,
  onOutput: (id: string, chunk: string) => void,
  onExit: (id: string, code: number) => void
): void {
  killAgent(id);
  createAgent(id, workingDirectory, name, onOutput, onExit);
}

export function getAgentPid(id: string): number | null {
  const ptyProcess = ptys.get(id);
  return ptyProcess ? ptyProcess.pid : null;
}

export function hasAgent(id: string): boolean {
  return ptys.has(id);
}
