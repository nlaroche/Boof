# Engine Improvements — What's Actually Broken

## Problem 1: Planning is blind

The planning prompt gives zero codebase context. Agent has to "explore" from scratch every time. No file tree, no module boundaries, no existing patterns to reference.

### Fix: Smart repo map in planning prompt

Build a ranked repo map using the TypeScript Compiler API + PageRank (~100 lines, zero deps):

1. `ts.createSourceFile()` on every .ts/.tsx file → extract exports (functions w/ signatures, interfaces, types, classes) + imports
2. Build import graph from the imports
3. Run PageRank (15 lines) over the import graph → rank files by connectivity/importance
4. Output: top N files with their exported symbols, sorted by rank
5. Cache per repo, invalidate on git HEAD change

For broad context (full file tree, file contents), use Repomix (npm, TypeScript, MIT, 8K stars) — it packs a repo into a single AI-friendly doc with token counting built in.

Include in planning prompt:
- Ranked repo map (top 20 files with signatures)
- "Here are 3 similar features for reference" (find by keyword matching in the map)
- Existing task history: "These tasks already exist for this goal. Don't duplicate."

For non-TS repos: `@ast-grep/napi` (Rust+Node, MIT, 8K stars) handles tree-sitter extraction. Later problem.

### Fix: Task success criteria

Current format: `TASK: title | description`
New format: `TASK: title | description | DONE_WHEN: specific testable condition`

The agent needs to know when to stop. "Add error handling" is unbounded. "Add try/catch to all async functions in src/api/ — build passes, no unhandled promise rejections in test output" is actionable.

### Fix: Dynamic task count

Don't hardcode "3-5 tasks." Estimate from goal complexity:
- Goal description length + keyword analysis → complexity score
- 1 task (trivial), 3 (simple), 5 (moderate), 8+ (complex)
- Include in prompt: "This goal is estimated as [moderate]. Propose ~5 tasks."

## Problem 2: Implementation prompt contradicts the scoring

Autopilot runs `rankTasks()`, picks the best task. Then the prompt says "Pick the most impactful pending task." Agent ignores the ranking and picks whatever it wants.

### Fix: Force the task

Replace the vague "pick the most impactful" with:
```
YOUR TASK: [title]
DESCRIPTION: [description]
DONE WHEN: [success criteria]
DO NOT work on anything else. Focus only on this task.
```

Remove the full pending task list from the prompt — it's a distraction. Agent only needs to know what it's doing right now.

## Problem 3: Memory is noise

Memory is free-form text dumped into prompts. Keyword matching for relevance. No structure, no validation, no decay by importance.

### Fix: Structured, validated memory in DB

Move from `.boof/memory.json` to database tables:

```sql
-- Concrete patterns with code
agent_patterns (
  id, agent_id, repo_path,
  name,           -- "Handle async errors in Express routes"
  trigger,        -- When to apply: "async route handler"
  code_example,   -- Actual code snippet (full, not truncated)
  anti_pattern,   -- What NOT to do
  verified,       -- Has this been used successfully?
  use_count,      -- Times applied
  success_count,  -- Times it helped
  domain_tags,    -- ["async", "express", "error-handling"]
  goal_id         -- Optional: scoped to a specific goal type
)

-- Error fixes that actually worked
agent_fixes (
  id, agent_id,
  error_signature, -- Regex or key phrase: "TS2307: Cannot find module"
  root_cause,      -- "Missing import statement"  
  fix_action,      -- "Add import at top of file"
  fix_code,        -- Actual code that fixed it
  times_seen,
  times_fixed,
  last_seen
)
```

Loading: match by domain tags + error signatures, not substring. Prioritize high-success-count entries.

### Fix: Validate before persisting

When agent extracts a "skill" or "pattern":
1. Check if it's actually new (dedup against existing patterns)
2. Tag it `verified: false`
3. Next time agent uses it and succeeds → mark `verified: true`
4. Only inject verified patterns into prompts
5. Patterns that get used but lead to failures get demoted

## Problem 4: Self-improvement doesn't close the loop

Reflections are recorded. Skills are extracted. Improvements are suggested. None of it actually changes agent behavior in a measurable way.

### Fix: Hypothesis → experiment → measure

When a reflection says "I should check imports before building":
1. Formulate as a testable prompt change: add "BEFORE editing, run `tsc --noEmit` to check for existing errors"
2. Create an A/B experiment: next 5 runs use the new instruction, compare scores
3. If scores improve → promote to permanent guideline
4. If no improvement → discard

This is the only way to know if "learning" is real.

### Fix: Make XP meaningful

XP currently does nothing. Tie it to behavior:
- Low XP agents: restricted to 1-2 file changes per task, must pass build + tests to get XP
- Mid XP agents: can do larger tasks, get autonomy on straightforward work
- High XP agents: can propose their own tasks, handle complex refactors

This creates a natural progression where agents earn trust.

## Problem 5: Assessment scoring is context-free

A refactor touching 8 files gets penalized the same as a bug fix touching 8 files. No positive signals — you can only lose points.

### Fix: Task-aware scoring

Input task metadata into scoring:
- Task type (feature, fix, refactor, test) → expected file count
- Penalize only when files touched exceeds expected range for that type
- Add positive signals: test coverage increased (+5), code simplified (+3), documentation added (+2)

### Fix: Trend tracking

Raw score means nothing without context. Track:
- Agent's rolling average (last 10 runs)
- Score relative to average: "This run was +7 above your average"
- Goal-specific performance: "On this goal, you're averaging 82"

## Problem 6: No escalation

Agent fails the same task 3 times → tries a 4th time. Tests broken by external cause → agent forced to fix them forever. No "this is blocked, move on."

### Fix: Failure classification + escalation

When a task fails:
1. Classify: `agent_error` (typo, bad logic) vs `environment_error` (broken dep, flaky test) vs `ambiguous_requirement` (task unclear)
2. Agent errors: retry (max 2x), then split task into smaller pieces
3. Environment errors: skip, log as system issue, notify
4. Ambiguous requirements: pause task, flag for human clarification

When 3+ tasks on a goal fail consecutively:
- Pause the goal
- Notify: "Goal X is stuck — 3 consecutive failures. [Review] [Adjust tasks] [Abandon]"

## Problem 7: Goal cycling thrashes context

TASKS_BEFORE_ROTATION=2 is hardcoded. Agent switches goals every 2 tasks, losing all context.

### Fix: Momentum-based rotation

- If agent is succeeding (>70% success on current goal): stay, don't rotate
- If agent is failing (<30% success): rotate immediately, this goal might be too hard
- Factor in goal completion: if goal is 80%+ done, finish it
- Never rotate mid-dependency: if task B depends on task A just completed, do B next

### Fix: Goal complexity → rotation threshold

- Simple goal (1-3 tasks): finish before rotating
- Medium goal (4-7 tasks): rotate after 3-4 tasks
- Complex goal (8+ tasks): rotate after 5 tasks (need breaks for fresh context)

## Build Order

1. **Smart repo map** — TS Compiler API + PageRank (~100 lines, zero deps) + Repomix for broad context. Inject into planning prompt so agents aren't blind.
2. **Force the task in implementation prompt** — 10 min change, immediate quality improvement
3. **Add success criteria to task format** — small prompt change, big clarity gain
4. **Failure classification + escalation** — stop agents from spinning on broken tasks
5. **Momentum-based goal rotation** — replace hardcoded TASKS_BEFORE_ROTATION
6. **Structured memory in DB** — replace fragile .boof/memory.json
7. **Task-aware assessment scoring** — make scores meaningful
8. **Closed-loop experiments** — the real self-improvement
