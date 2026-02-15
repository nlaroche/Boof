Create these utility files:

1. src/client/lib/ansi.ts - ANSI to HTML converter:
Export function ansiToHtml(text: string): string that converts ANSI escape codes to HTML spans.
Support: basic colors 30-37 (black,red,green,yellow,blue,magenta,cyan,white), bright 90-97, background 40-47/100-107, bold (font-weight:bold), reset. Map colors to hex values. Strip unrecognized escape sequences. Return HTML string with spans.

2. src/client/lib/format.ts - Formatting helpers:
- timeAgo(dateStr: string): string - converts ISO date to "just now", "2m ago", "1h ago", "3d ago" etc
- truncate(str: string, maxLen: number): string - truncate with ellipsis

3. src/client/hooks/useWebSocket.ts - WebSocket hook:
- Connects to ws:// or wss:// based on window.location.protocol
- URL: protocol + '//' + host + '/ws'
- Auto-reconnects with exponential backoff (1s, 2s, 4s, max 30s)
- On connect: sends JSON { type: 'sync:request' }
- On message: parse JSON and route to zustand store:
  - sync:state -> store.setFolders, setTasks, setAgents
  - agent:output -> store.appendOutput
  - agent:status -> store.setAgentStatus
  - task:updated -> store.updateTask
  - folder:updated -> store.updateFolder
- Exports: { send: (msg: object) => void, connected: boolean }
- Use useEffect for lifecycle, useRef for ws instance, useState for connected

4. src/client/hooks/useSpeech.ts - Web Speech API:
- Uses SpeechRecognition or webkitSpeechRecognition
- Exports: { transcript: string, isListening: boolean, startListening: () => void, stopListening: () => void, resetTranscript: () => void, supported: boolean }
- Continuous mode, interimResults true, lang 'en-US'
- Updates transcript in real time
