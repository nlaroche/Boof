# Architecture

Game-engine-inspired autonomous agent orchestrator. Agents are characters, goals are quests, tasks are objectives.

## Core Loop

```
observe state → score options → pick best → execute → assess → learn → repeat
```

## Directory Structure

```
src/server/
  engine/                        # Core engine (generic, reusable)
    constants.ts                 # All enums, timeouts, limits, scoring weights
    state-machine.ts             # Generic FSM with context, invariants, history
    scoring.ts                   # Utility AI scoring (normalize, weight, combine)
    event-bus.ts                 # Typed pub/sub event system
    assert.ts                    # Assertion utilities
    __tests__/                   # Engine + experiment tests

  machines/                      # Entity lifecycle state machines
    agent-machine.ts             # idle → running → error/dead
    goal-machine.ts              # active ↔ paused → completed
    task-machine.ts              # todo → in_progress → done → archived
    command-machine.ts           # running → checking → retrying → done/failed
    autopilot-machine.ts         # 13-state autopilot run lifecycle
    merge-gate-machine.ts        # 10-state consolidation/review/merge lifecycle

  systems/                       # Focused modules (one concern each)
    prompt-builder.ts            # All agent-facing prompt templates
    goal-planner.ts              # Goal decomposition + task parsing from agent output
    repo-map.ts                  # TS Compiler API + PageRank ranked codebase map
    task-selector.ts             # Utility-scored task/goal selection
    command-lifecycle.ts         # Command exit handling, retry, review, commit
    git-ops.ts                   # Branch management, merging, worktrees
    build-runner.ts              # Build and test execution
    failure-tracker.ts           # Failure classification + escalation
    experiment-loop.ts           # Closed-loop A/B experiments (strategies, stats, hypothesis gen)
    consolidation.ts             # Merge gate orchestration (consolidate → review → test → merge)
    review-agent.ts              # Review guidelines, repo scanning, review prompt building
    audit-trail.ts               # Hash-chained audit logging
    self-heal.ts                 # Merge conflict + test failure auto-fix

  autopilot.ts                   # Main orchestrator — ties all systems together
  ws-handler.ts                  # WebSocket message routing (thin dispatcher)
  db-helpers.ts                  # All CRUD operations
  db.ts                          # Schema + sql.js wrapper
  pty-manager.ts                 # PTY/child_process management for Claude Code
  self-improve.ts                # XP, assessments, skills, reflections, experiments
  agent-memory.ts                # Agent memory (file-based + DB structured patterns/fixes)
  agent-providers.ts             # Model provider registry (7 providers with pricing)
  scheduler.ts                   # Cron-based scheduling
  branch-guard.ts                # Protected branch enforcement
```

## System Descriptions

### Autopilot (`autopilot.ts`)
The main orchestrator. Runs a 30s loop checking for idle agents with autopilot enabled. For each: picks a goal, scores tasks, runs an agent, assesses results, cycles goals. Imports from all systems but delegates implementation to them.

### Prompt Builder (`systems/prompt-builder.ts`)
All agent-facing prompt text. Two main prompts: `buildAutopilotPrompt()` for implementation runs, `buildPlanningPrompt()` for goal decomposition. Includes repo map, memory context, forced task assignment with DONE_WHEN criteria.

### Goal Planner (`systems/goal-planner.ts`)
Parses `TASK: title | description | DONE_WHEN: condition` lines from agent planning output. Creates task records in DB. Manages the "Goal Tasks" folder for agent-generated tasks.

### Repo Map (`systems/repo-map.ts`)
Builds a ranked codebase context using the TypeScript Compiler API. Parses every .ts/.tsx file, extracts exports (functions with signatures, interfaces, types), builds import graph, runs PageRank. Cached per repo, invalidated on git HEAD change. Zero external deps.

### Task Selector (`systems/task-selector.ts`)
Multi-factor utility scoring for tasks and goals. Factors: priority, skill match, freshness, failure penalty. Goals scored by: priority, momentum, staleness, completion urgency, task availability.

### Failure Tracker (`systems/failure-tracker.ts`)
Classifies task failures as `agent_error` / `environment_error` / `ambiguous_requirement` using pattern matching on error output. Decides escalation: retry, skip, pause task, pause goal, or split task. Tracks consecutive failures per agent per goal.

### Experiment Loop (`systems/experiment-loop.ts`)
Closed-loop A/B testing. Strategy pattern for 5 experiment types: prompt, model, pattern, workflow, fix. Each implements `applyVariant()`, `promote()`, `rollback()`. Statistical analysis: Welch's t-test + Cohen's d. Auto-generates hypotheses from reflections, failure clusters, and cost analysis. Block randomization (ABBA). Promotes winners, rolls back losers, audits everything.

### Consolidation (`systems/consolidation.ts`)
Merge gate orchestration. When all tasks for a goal complete, merges task branches into a goal branch, runs review agent, runs E2E tests, self-heals on failure, merges to target branch. 10-state FSM.

### Review Agent (`systems/review-agent.ts`)
Per-repo review guidelines that the QA agent follows. Auto-discovers architecture docs, YAML configs, JSON data patterns. Deep-scan reads source files to synthesize guidelines. Guidelines are individually approvable. Scope-filtered by glob pattern.

### Self-Improve (`self-improve.ts`)
XP and leveling, performance assessment (task-type-aware scoring with positive signals), reflections, skill extraction, prompt versioning, A/B experiments (old system — being replaced by experiment-loop.ts).

### Agent Memory (`agent-memory.ts`)
Dual-layer: file-based (`.boof/memory.json` — patterns, mistakes, guidelines) + DB-structured (`agent_patterns` with domain tags and verification, `agent_fixes` with error signatures). Loaded into prompts filtered by task relevance.

### Cost Tracking
Per-provider pricing in `agent-providers.ts`. Cost calculated from tokens on every run, stored in `run_metrics.cost_usd`. Budget caps on goals — autopilot pauses goal if budget exceeded.

## Client Architecture

```
src/client/
  screens/                         # One per nav route
    DashboardScreen.tsx            # Desktop overview (stats, agents, skills)
    HomeScreen.tsx                 # Mobile agent list
    ProjectsScreen.tsx             # Project CRUD + master-detail
    GoalsScreen.tsx                # Goal management + approval workflow
    TasksScreen.tsx                # Folder-organized task management
    AgentsScreen.tsx               # Agent CRUD + settings
    AgentScreen.tsx                # Agent detail (output, history, XP)
    HistoryScreen.tsx              # Command history feed
    PipelineScreen.tsx             # Merge gate FSM lifecycle
    ReviewsScreen.tsx              # Review findings across gates
    AuditScreen.tsx                # Hash-chained audit timeline
    ResearchScreen.tsx             # Task research library
    MemoryScreen.tsx               # Agent patterns, fixes, guidelines
    AnalyticsScreen.tsx            # Cost, performance, experiments

  components/                      # Reusable UI pieces
    ui/                            # shadcn/ui primitives (badge, button, card, dialog, etc.)
    StatusBar.tsx                  # Desktop header: connection, agents, cost
    SideNav.tsx                    # Desktop nav: Workspace + Systems groups
    BottomNav.tsx                  # Mobile nav
    ContextPanel.tsx               # Desktop right panel (360px, collapsible)
    PipelineVisualization.tsx      # Merge gate FSM node chain
    DrawerModal.tsx                # Mobile drawer / desktop dialog

  hooks/
    useIsDesktop.ts                # 768px + 1280px breakpoint hooks
    useWebSocket.ts                # WS connection, message dispatch to store

  lib/
    types.ts                       # All entity + WS message types
    format.ts                      # timeAgo, formatTokens, formatCost, safeJsonParse
    ui-constants.ts                # Badge variant maps, pipeline states
    lookups.ts                     # useEntityMap hook + lookupName helper
    utils.ts                       # cn() class merge utility

  stores/
    store.ts                       # Zustand: all entity slices + UI state
```

### Desktop Layout (>=1280px)
```
+----------+-------------------------+------------------+
| SideNav  |    Main Content         | Context Panel    |
| 224px    |    flex-1               | 360px, optional  |
+----------+-------------------------+------------------+
Status Bar (top, 32px): connection dot, agent count, cost
```

### Mobile Layout (<768px)
Content + BottomNav (unchanged). System screens (Pipeline, Reviews, etc.) are desktop-only.

## Data Flow

```
Phone/Browser → WebSocket → ws-handler.ts → system function → db-helpers → SQLite
                                                    ↓
                                              broadcast(WSServerMessage)
                                                    ↓
                                          All connected clients
```

Autopilot loop (server-side, no WS trigger):
```
30s timer → checkAutopilotAgents() → triggerAutopilotRun(agentId)
  → prompt-builder → pty-manager (Claude Code) → command-lifecycle
  → build-runner → self-improve (assess) → experiment-loop (record)
  → goal-planner (if planning) → git-ops (branch/merge)
  → failure-tracker (if failed) → consolidation (if goal done)
```

## Engine Patterns

### State Machines
Every entity lifecycle is a `MachineDefinition<State, Event, Context>`. Instantiate with `new StateMachine(def)`. States have descriptions, invariants, onEnter hooks. Transitions have guards and reducers. Full history recorded.

### Utility Scoring
Multiplicative combination of weighted factors. Zero on any factor = hard veto. All factors normalized to 0-1. Used for task selection and goal rotation.

### Event Bus
Typed pub/sub (`bus.on('event', handler)`, `bus.emit('event', data)`). Events defined in `BusEvents` interface. Used for decoupled system-to-system communication.

## Experiment System

Lifecycle: `proposed → queued → running → analyzing → promoted / rolled_back / inconclusive`

Strategies (pluggable via `registerStrategy()`):
- **PromptStrategy**: A/B test prompt changes. Promotes via `createPromptVersion()`.
- **ModelStrategy**: Compare providers. Promotes by updating `agents.agent_type`.
- **PatternStrategy**: Verify if `agent_patterns` help. Promotes via `markPatternVerified()`.
- **WorkflowStrategy**: Test step modifications. Promotes by updating workflow.
- **FixStrategy**: Verify if `agent_fixes` prevent recurrence. Promotes via `markFixSucceeded()`.

Statistics: Welch's t-test (p < 0.05) + Cohen's d (>= 0.3). Min 8 runs/variant. Early stop if treatment clearly harmful.

Hypothesis generation: auto from reflections, failure clusters, cost analysis, unverified patterns. Triggered every 5 runs.
