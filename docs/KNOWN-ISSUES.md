# Known Issues — Full Review 2026-07-05

Ranked, verified defects from a full server + client + production review.
**Phase 1 fix pass landed 2026-07-05** (merge commits `d9fcf22`, `4b5b94b`, `1c257f7` + integration fixes): all Critical and High items and most Medium items below are resolved. Kept here as a changelog; open items are in the last section.

## Fixed in Phase 1

**Critical:** C1 spawn-failure crash (cp.on('error') + 60-min run watchdog), C2 wedged gates (fail-closed to `failed` with actionable reasons; FSM state restored from DB after restart; send() results checked), C3 review fail-open (unparseable/empty/non-zero-exit review → changes_requested/failed, never approve), C4 silent work loss on merge conflict (conflict left in place for heal; gate fails loudly naming the branch if heal can't), C5 client XSS/corruption (output escaped before ANSI render).

**High:** H1 autopilot wedge on inactive goal (rotates or clears pin + backoff; last_run always updated), H2 `+` worktree marker (branch listing via `--format=%(refname:short)`), H3 stale PTY handlers (agent unregistered after autopilot runs), H4 done-before-merge / failed-final-task skipping consolidation, H5 dead rebase + branch buildup (rebase in agent worktree; worktree removed before branch delete), H6 git races (exported `withRepoLock` keyed by git-common-dir; all mutating ops in git-ops/maintenance + autopilot's raw worktree-add routed through it), H7 unhandled WS rejections, H8 hardcoded build/test (review_configs.test_command → package.json scripts → explicit skip), H9 Select crash, H10 dead Reviews screen, H11 notify discarded (toasts + Web Notification + badges; server broadcasts reviewFinding:updated on resolve).

**Medium:** M1 real cost tracking (stream-json usage captured; estimate fallback; goal_log cost; explicit null budget checks; `global:stats.costTodayUsd`), M2 interrupt no longer auto-retries, M3 scheduler wired + skips busy agents + minute dedup, M5 no commits on detached HEAD / guarded branches, M6 dead→idle on startup, M7 per-agent experiment/skill state, M8 "completed with failures" surfaced + correct goal name in notification, M9 origin-less repos + remote-prune skip, M10 shell injection (execFile arg arrays), M11/M12 reconnection (visibility/online reconnect, send-queue, output replay dedup, per-screen re-fetch), M13 analytics ×100 + experiments fetch, M14 ghost-agent guard, M15 mergeTarget now persisted on goal:create (client + server + INSERT).

**Low:** merge-gate broadcast name, mergeGate:merge status guard (+`force`), PIPELINE_STATES failed, toast spam, emptyOutDir, chunk line-stitching, zombie reconnect timer, loading skeletons wired, research trigger tightened + cheap model, `.catch(() => {})` purge in owned files, dead imports/components removed, pre-existing experiment-loop type errors (verdict/status enum mixup — a no-strategy promote verdict leaked 'promote' into the status column).

**Correction to the original review:** `reviewConfig:*`, `maintenance:*`, and `audit:summary` DO have server handlers (ws-handler.ts:706+); only `analytics:cost`/`analytics:performance` were dead and removed.

## Fixed in Phase 2 (2026-07-05)

- M4 sql.js persistence: atomic tmp+rename writes with `.bak` rotation, ~500ms debounced flush (was per-statement full rewrite), sync `flushDb()` on shutdown, daily retention pruning (raw_output truncation >14d, orphaned commands >30d, consolidated_diff capped 256KB; audit chain never pruned).
- Web Push end-to-end: VAPID (env or generated `.vapid-keys.json` at first boot), DB-persisted subscriptions with 404/410 pruning, `push:subscribe/unsubscribe/vapid-key` WS messages, injectManifest service worker with push + click-through, 3-state NotificationToggle. Pushed events: warning/error notify, gate approved, agent-proposed goals. Kill switch `PUSH_DISABLED=1`. Requires HTTPS origin on the phone.
- Review/research agents no longer run in the human's checkout: review runs in a disposable worktree at the goal branch tip; research runs in the agent's worktree.
- Mobile approve loop (GateSheet: pipeline viz + findings + one-tap Merge/Abort), tasks on mobile (GoalCard), Assign Agent on GoalCard, goal create with project/budget/priority/assign-now (server wiring included), project repo/goal attachment, fleet Activity feed (Home + Dashboard), History API back-button, ContextPanel removed.

## Still open

- [ ] **Revision loop** — `healing`/`revising` now fail closed instead of wedging; the actual automated heal/revise drivers (recordHealSuccess/completeRevision hooks) are still future work.
- [ ] **Residual git-lock gaps** — command-lifecycle's synchronous commit path and git-ops' `createWorktree`/`removeWorktree` (execSync) aren't routed through `withRepoLock` (low risk: agent-worktree-local ops; git fail-fast-locks refs).
- [ ] **Per-goal spend aggregate** — GoalCard budget bars sum client-loaded goal logs (capped at 15/goal), so long-running goals undercount. Proper fix: server-side SUM per goal in goal payloads or a `goals:spend` message.
- [ ] **Merge-gate transition history** — Activity feed approximates gate transitions from `updated_at` + current status; a per-gate event log would give true history.
- [ ] **File-size limits still blown** (autopilot.ts ~1300/800, ws-handler ~1000/800, review-agent 985/500, experiment-loop 958/500, consolidation/maintenance/command-lifecycle over 500) — refactor opportunistically, don't big-bang.
- [ ] **Prod housekeeping** — untracked debug scripts in `~/projects/boof` (user's), no log rotation for logs/boof.log.
- [ ] **Auto-proposed goal quality** — reflection-generated "Follow-up:" goals have truncated names and low value; needs a quality bar / length fix before agents churn on them.
