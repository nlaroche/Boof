# Boof — What to Build Next

Personal tool. The goal is to move faster on my own projects and deliver more on contracts. Everything below is ranked by "how much faster does this make me."

## What I Have That Already Works

- Mobile PWA — control agents from phone, real-time output
- Multi-agent autopilot — assign goals, walk away, agents cycle through tasks
- Branch isolation — worktrees keep agents from stepping on each other
- Review + merge layer — goal branches, QA review agent, self-healing, audit trail
- Guideline system — teach the QA agent any repo's architecture
- Self-improvement — agents learn from mistakes, track skills, reflect
- Workflows — Implement → Build → Test → QA Review pipeline

## What Would Actually Make Me Faster

### 1. Cost Tracking & Budget Caps
Right now I have no idea what a goal costs until I check my API dashboard manually. If an agent gets stuck in a loop overnight, it burns money.

- Parse token usage from Claude Code stream-json output (it's already there)
- Track cost per agent/goal/task
- Hard cap: kill agent if task exceeds $X
- Show running total on the agent card in the UI

This is the difference between confidently running agents overnight vs. nervously checking my phone.

### 2. GitHub PR Creation from Merge Gates
For contracts, I need real PRs — not local merges. Clients want to see PRs in their repo.

- After merge gate approves + tests pass, `gh pr create` instead of local merge
- Auto-generate PR description from goal name, tasks, review findings
- Post review findings as inline PR comments
- From phone: one-tap approve/merge

This turns boof from "my personal tool" into "my delivery pipeline for client work."

### 3. Actionable Push Notifications
The overnight dream doesn't work if I have to keep opening the app to check status.

- "Task done, tests pass" → [Approve] [Review]
- "Agent stuck 15 min, spent $2.30" → [Kill] [Hint] [Ignore]
- "Review found 2 critical issues" → [View] [Auto-fix]
- Morning digest: "4 tasks done, 1 failed, $8.20 spent, 2 PRs ready"

### 4. Sleep Mode
Package what exists into one "going to bed" flow:

- Pick goals/tasks to work on overnight
- Set budget cap, quality floor, time limit (stop at 6 AM)
- Morning: summary notification + dashboard of what happened
- One screen to approve/reject everything

Most of the pieces exist (autopilot, merge gate, review agent). This is mostly UI + orchestration glue.

### 5. Multi-Provider / Cost-Aware Routing
Not every task needs Claude Opus. Simple tasks (rename variable, add test) should use Haiku or Sonnet. Complex architecture work gets Opus.

- Already have agent_type/provider abstraction
- Add task complexity estimation → pick cheapest capable model
- Fallback chain: if rate-limited on one provider, try another
- Add Aider + Codex CLI as providers (some contracts may require non-Anthropic)

### 6. Better Contract Onboarding
When I pick up a new contract, I need boof to understand the client's repo fast.

- `guidelines:scan` already discovers docs — make it faster and more thorough
- `guidelines:deep-scan` reads source and synthesizes architecture understanding
- Add a "New Contract Setup" flow: point at repo → scan → review guidelines → create initial goals
- Generate an architecture summary the QA agent uses for all reviews

### 7. Cross-Repo Goals
Some contracts touch multiple repos (API + client, monorepo packages, etc.)

- Goal spans repos A and B
- Agent works repo A first (API), then repo B (client SDK)
- Review agent checks both repos for compatibility
- Already have project → repo associations, just need goal-level orchestration

### 8. Diff Viewer on Phone
When I'm reviewing from my phone, I want to see the actual diff — not just "3 files changed."

- Mobile-friendly diff viewer with syntax highlighting
- Swipe through files
- Inline review findings shown on the diff
- Approve/reject per file

### 9. Audit Trail for Client Deliverables
For contracts, being able to show "here's exactly what the AI did and how it was reviewed" builds trust.

- Already have hash-chained audit trail
- Add export: generate a PDF/markdown report of a goal's full history
- Include: tasks, agent decisions, review findings, test results, merge timeline
- "Here's the audit log for this feature" → client confidence

### 10. Smarter Agent Memory
Agents still lose context between sessions. For a long-running contract, the agent should remember what it learned last week.

- Cross-session memory is partially there (agent-memory.ts, .boof/ dir)
- Make it more structured: repo knowledge graph (modules, dependencies, conventions)
- Pattern library: when agent solves something, save the approach
- Convention drift detection: flag when new code doesn't match established patterns

## Build Order (What to Do First)

1. **Cost tracking** — easy win, high impact, no more anxiety about overnight runs
2. **Push notifications** — make overnight actually work without checking phone
3. **Sleep Mode UI** — package the overnight experience
4. **GitHub PR creation** — unlock contract delivery
5. **Diff viewer on phone** — better review experience
6. **Contract onboarding flow** — faster ramp-up on new work
7. Everything else as needed

## The Point

Boof should let me:
- Take a contract, point boof at the repo, and have it understand the codebase in minutes
- Assign goals before bed and wake up to PRs that are actually reviewable
- Review and approve from my phone while having coffee
- Show clients a clean audit trail of what was done and how it was verified
- Use the cheapest model that works for each task, not burn money on Opus for trivial changes
- Deliver 3-5x more output than a solo developer normally could
