Build the complete client-side PWA with all screens and components. This is a mobile-first dark-themed app for controlling Claude Code agents from a phone.

IMPORTANT DESIGN REQUIREMENTS:
- Dark theme: bg #0a0a0f, surface #14141f, border #1e1e2e, primary #7c5bf5, success #22c55e, warning #f59e0b, error #ef4444, text #e2e2ef, text-secondary #6b6b80
- Font: Inter for UI, JetBrains Mono for terminal
- Bottom navigation bar (NOT top)
- Large touch targets (min 48px)
- Border radius: 12px cards, 8px buttons

CREATE ALL THESE FILES:

1. src/client/stores/store.ts - Zustand store with sections: folders, tasks, agents, activeOutputs (Map of agentId->string[]), ui (activeScreen, selectedAgentId, selectedFolderId). Actions: setFolders, setTasks, setAgents, appendOutput, setAgentStatus, updateTask, updateFolder, setActiveScreen. The store is the single source of truth, hydrated from WebSocket sync:state messages.

2. src/client/hooks/useWebSocket.ts - Custom hook that:
   - Connects to ws://hostname:port/ws (or wss:// if https)
   - Auto-reconnects with exponential backoff (1s, 2s, 4s, max 30s)
   - Sends sync:request on connect
   - Routes incoming messages to Zustand store updates
   - Exports: send(msg), connected boolean, reconnecting boolean
   - Shows reconnecting state

3. src/client/hooks/useSpeech.ts - Web Speech API wrapper:
   - Exports: transcript, isListening, startListening, stopListening, supported
   - Uses SpeechRecognition (with webkit prefix fallback)
   - Continuous mode, interim results shown in real-time
   - Language: en-US

4. src/client/lib/ansi.ts - ANSI escape code parser:
   - Export function ansiToHtml(text: string): string
   - Convert ANSI color codes to HTML spans with inline styles
   - Support basic colors (30-37, 40-47), bright (90-97, 100-107), bold, reset
   - Strip other escape sequences

5. src/client/lib/format.ts - Formatting helpers:
   - timeAgo(dateStr: string): string - "2m ago", "1h ago", etc
   - truncate(str: string, maxLen: number): string

6. src/client/components/BottomNav.tsx - Bottom navigation bar with 4 tabs:
   - Home (house icon), Tasks (list icon), Agents (robot icon), History (clock icon)
   - Active tab highlighted with primary color
   - Fixed to bottom, safe-area padding
   - Uses store.setActiveScreen

7. src/client/components/AgentCard.tsx - Agent status card:
   - Shows agent name, working directory, status badge (colored dot)
   - Last activity time via timeAgo
   - Clickable to navigate to agent screen

8. src/client/components/AgentOutput.tsx - Terminal output display:
   - Scrollable div with monospace font (JetBrains Mono)
   - Takes lines: string[] prop
   - Auto-scrolls to bottom on new content
   - Renders ANSI colors via ansiToHtml
   - Dark background (#0a0a0f) with slight padding

9. src/client/components/CommandInput.tsx - Input bar for sending commands:
   - Text input + mic button + send button
   - Fixed to bottom above nav
   - Send button is primary purple, mic button toggles
   - onSend callback, onMicToggle callback
   - Expandable textarea that grows with content

10. src/client/components/TaskItem.tsx - Task row:
    - Checkbox (circle) on left, title text, status indicator
    - Tap checkbox toggles between todo/done
    - Shows subtask count if any

11. src/client/components/FolderList.tsx - Folder cards:
    - Grid of folder cards showing icon, name, task count (done/total)
    - Tap to select folder and show its tasks
    - Plus button to create new folder

12. src/client/components/QuickActions.tsx - Grid of quick action buttons:
    - Continue, Test, Commit, Explain, Status, Fix, Refactor, Plan
    - 3-column grid of tappable buttons
    - Each sends a predefined prompt to the selected agent

13. src/client/components/SummaryCard.tsx - Completed command summary:
    - Shows summary text, files changed list, time ago
    - Compact card with subtle border

14. src/client/screens/HomeScreen.tsx - Dashboard:
    - Title "Boof" at top
    - Active agents grid (AgentCard components)
    - Quick actions grid
    - Recent completed commands with summaries
    - "New Agent" button

15. src/client/screens/TasksScreen.tsx - Task management:
    - Folder list at top
    - When folder selected, show tasks for that folder
    - Task items with checkboxes
    - Add task button (simple inline form)
    - Add folder button

16. src/client/screens/AgentScreen.tsx - Single agent view:
    - Header with agent name, status, back button
    - Terminal output area (AgentOutput component)
    - Summary card (if last command completed)
    - Command input bar at bottom
    - Integrates with useSpeech for voice input

17. src/client/screens/AgentsScreen.tsx - All agents overview:
    - List of all agents with status badges
    - "New Agent" button with working directory input
    - Kill/restart buttons per agent

18. src/client/screens/HistoryScreen.tsx - Command history:
    - List of past commands with summaries
    - Shows agent name, prompt, summary, time
    - Simple scrollable list

19. Update src/client/App.tsx - Root component:
    - WebSocket provider (useWebSocket hook)
    - Screen router based on store.ui.activeScreen
    - Bottom navigation bar
    - Connection status indicator (show banner when disconnected)
    - Wrap everything in the proper layout

All components should use Tailwind CSS classes. Use the dark theme colors consistently. Make everything look polished and professional for mobile use.
