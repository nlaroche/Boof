# Known Issues — Full Review 2026-07-05

Ranked, verified defects from a full server + client + production review.
**Phase 1 fix pass landed 2026-07-05** (merge commits `d9fcf22`, `4b5b94b`, `1c257f7` + integration fixes): all Critical and High items and most Medium items below are resolved. Kept here as a changelog; open items are in the last section.

## Fixed in Phase 1

**Critical:** C1 spawn-failure crash (cp.on('error') + 60-min run watchdog), C2 wedged gates (fail-closed to `failed` with actionable reasons; FSM state restored from DB after restart; send() results checked), C3 review fail-open (unparseable/empty/non-zero-exit review → changes_requested/failed, never approve), C4 silent work loss on merge conflict (conflict left in place for heal; gate fails loudly naming the branch if heal can't), C5 client XSS/corruption (output escaped before ANSI render).

**High:** H1 autopilot wedge on inactive goal (rotates or clears pin + backoff; last_run always updated), H2 `+` worktree marker (branch listing via `--format=%(refname:short)`), H3 stale PTY handlers (agent unregistered after autopilot runs), H4 done-before-merge / failed-final-task skipping consolidation, H5 dead rebase + branch buildup (rebase in agent worktree; worktree removed before branch delete), H6 git races (exported `withRepoLock` keyed by git-common-dir; all mutating ops in git-ops/maintenance + autopilot's raw worktree-add routed through it), H7 unhandled WS rejections, H8 hardcoded build/test (review_configs.test_command → package.json scripts → explicit skip), H9 Select crash, H10 dead Reviews screen, H11 notify discarded (toasts + Web Notification + badges; server broadcasts reviewFinding:updated on resolve).

**Medium:** M1 real cost tracking (stream-json usage captured; estimate fallback; goal_log cost; explicit null budget checks; `global:stats.costTodayUsd`), M2 interrupt no longer auto-retries, M3 scheduler wired + skips busy agents + minute dedup, M5 no commits on detached HEAD / guarded branches, M6 dead→idle on startup, M7 per-agent experiment/skill state, M8 "completed with failures" surfaced + correct goal name in notification, M9 origin-less repos + remote-prune skip, M10 shell injection (execFile arg arrays), M11/M12 reconnection (visibility/online reconnect, send-queue, output replay dedup, per-screen re-fetch), M13 analytics ×100 + experiments fetch, M14 ghost-agent guard, M15 mergeTarget now persisted on goal:create (client + server + INSERT).

**Low:** merge-gate broadcast name, mergeGate:merge status guard (+`force`), PIPELINE_STATES failed, toast spam, emptyOutDir, chunk line-stitching, zombie reconnect timer, loading skeletons wired, research trigger tightened + cheap model, `.catch(() => {})` purge in owned files, dead imports/components removed, pre-existing experiment-loop type errors (verdict/status enum mixup — a no-strategy promote verdict leaked 'promote' into the status column).

**Correction to the original review:** `reviewConfig:*`, `maintenance:*`, and `audit:summary` DO have server handlers (ws-handler.ts:706+); only `analytics:cost`/`analytics:performance` were dead and removed.

## Still open

- [ ] **M4. sql.js persistence** — whole-DB synchronous rewrite per statement, non-atomic (db.ts:598-614). Needs tmp-file+rename (crash safety), debounced writes, and retention pruning for unbounded tables (commands.raw_output, merge_gates.consolidated_diff, goal_log, audit_records, run_metrics). *(assigned: Phase 2)*
- [ ] **Push notifications end-to-end** — VAPID init, DB-persisted subscriptions, WS subscribe handler, service-worker push + click-through. Client-side in-app notify is done; push while the PWA is closed is not. *(assigned: Phase 2)*
- [ ] **Review/research agents run in the main repo cwd with `--dangerously-skip-permissions`** (consolidation.ts, research.ts) — should run in a worktree. *(assigned: Phase 2)*
- [ ] **Revision loop** — `healing`/`revising` now fail closed instead of wedging; the actual automated heal/revise drivers (recordHealSuccess/completeRevision hooks) are still future work.
- [ ] **Residual git-lock gaps** — command-lifecycle's synchronous commit path and git-ops' `createWorktree`/`removeWorktree` (execSync) aren't routed through `withRepoLock` (low risk: agent-worktree-local ops; git fail-fast-locks refs).
- [ ] **ContextPanel** is still an unopenable stub (`setContextPanel` never called) — wire or remove. *(assigned: Phase 2)*
- [ ] **Projects are display-only** — no UI to add repos (`project:add-repo` unused) or attach goals. *(assigned: Phase 2)*
- [ ] **GoalCard budget bar reads $0 until first expand** (spend summed from lazily-loaded goalLogs) — needs a server-side aggregate per goal.
- [ ] **File-size limits still blown** (autopilot.ts ~1300/800, ws-handler ~900/800, review-agent 985/500, experiment-loop 958/500, consolidation/maintenance/command-lifecycle over 500) — refactor opportunistically, don't big-bang.
- [ ] **Prod housekeeping** — untracked debug scripts in `~/projects/boof` (user's), no log rotation for logs/boof.log.
- [ ] **Auto-proposed goal quality** — reflection-generated "Follow-up:" goals have truncated names and low value; needs a quality bar / length fix before agents churn on them.
