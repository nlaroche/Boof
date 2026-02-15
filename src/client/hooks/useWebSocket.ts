import { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../stores/store';
import type { WSClientMessage, WSServerMessage } from '../lib/types';

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const backoff = useRef(1000);

  const store = useStore();

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      backoff.current = 1000;
      ws.send(JSON.stringify({ type: 'sync:request' }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WSServerMessage;
        const s = useStore.getState();

        switch (msg.type) {
          case 'sync:state':
            s.setFolders(msg.folders);
            s.setTasks(msg.tasks);
            s.setAgents(msg.agents);
            break;
          case 'agent:output':
            s.appendOutput(msg.agentId, msg.chunk);
            break;
          case 'agent:updated':
            s.updateAgent(msg.agent);
            break;
          case 'agent:deleted':
            s.removeAgent(msg.agentId);
            break;
          case 'agent:status':
            s.setAgentStatus(msg.agentId, msg.status);
            break;
          case 'repos:list':
            s.setRepos(msg.repos);
            break;
          case 'agent:history':
            s.setCommands(msg.commands);
            break;
          case 'task:updated':
            s.updateTask(msg.task);
            break;
          case 'folder:updated':
            s.updateFolder(msg.folder);
            break;
          case 'agent:summary':
            s.updateCommand(msg.commandId, {
              summary: msg.summary,
              files_changed: msg.filesChanged,
              status: 'done',
            });
            break;
          case 'notify':
            // Could trigger browser notification here
            break;
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      reconnectTimer.current = setTimeout(() => {
        backoff.current = Math.min(backoff.current * 2, 30000);
        connect();
      }, backoff.current);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  const send = useCallback((msg: WSClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { send, connected };
}
