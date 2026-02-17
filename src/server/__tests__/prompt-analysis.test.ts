import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzePrompt,
  comparePrompts,
  generatePromptReport,
  estimatePromptCost,
  extractGoalPatterns,
  detectGoalGap,
} from '../prompt-analysis.js';

describe('prompt-analysis', () => {
  describe('analyzePrompt', () => {
    it('should break down prompt into sections and estimate tokens', () => {
      const prompt = `LEARNED PATTERNS:
- Pattern 1
- Pattern 2

You are working on goal: "Test goal"
Description: Do stuff

RULES:
1. Rule one
2. Rule two

Pick a task and implement it.`;

      const analysis = analyzePrompt(prompt);

      assert.ok(analysis.totalTokens > 0);
      assert.ok(analysis.sections.length > 0);
      assert.ok(analysis.sections.every(s => s.percentage >= 0));
    });

    it('should detect redundant "ALWAYS" usage', () => {
      const prompt = `ALWAYS do this. ALWAYS do that. ALWAYS remember. ALWAYS check.`;

      const analysis = analyzePrompt(prompt);

      assert.ok(analysis.redundancies.includes(
        'Excessive use of "ALWAYS" - consider consolidating rules'
      ));
    });

    it('should detect multiple IMPORTANT markers', () => {
      const prompt = `IMPORTANT: Do this. IMPORTANT: Also this. IMPORTANT: And this.`;

      const analysis = analyzePrompt(prompt);

      assert.ok(analysis.redundancies.some(r => r.includes('IMPORTANT')));
    });

    it('should detect repeated goal mentions', () => {
      const prompt = `Goal: Test\nWorking on goal: Test\nFor this goal: Test`;

      const analysis = analyzePrompt(prompt);

      assert.ok(analysis.redundancies.some(r => r.includes('Goal mentioned')));
    });

    it('should recommend reducing large sections', () => {
      const largeContent = 'A'.repeat(4000); // ~1000 tokens
      const prompt = `LEARNED PATTERNS:\n${largeContent}\n\nSome other content`;

      const analysis = analyzePrompt(prompt);

      assert.ok(analysis.recommendations.length > 0);
    });
  });

  describe('comparePrompts', () => {
    it('should calculate token savings', () => {
      const before = 'This is a long prompt with lots of content that we want to reduce';
      const after = 'Short prompt';

      const comparison = comparePrompts(before, after);

      assert.ok(comparison.tokenSavings > 0);
      assert.ok(comparison.percentageReduction > 0);
    });

    it('should detect removed sections', () => {
      const before = `RULES:\n1. Rule\n\nPATTERNS:\n- Pattern`;
      const after = `RULES:\n1. Rule`;

      const comparison = comparePrompts(before, after);

      assert.ok(comparison.sectionsRemoved.length > 0);
    });
  });

  describe('generatePromptReport', () => {
    it('should generate a readable report', () => {
      const prompt = `RULES:\nDo this\n\nGoal: Test\nDescription: Stuff`;

      const report = generatePromptReport(prompt);

      assert.ok(report.includes('PROMPT TOKEN ANALYSIS'));
      assert.ok(report.includes('Total estimated tokens:'));
      assert.ok(report.includes('Breakdown by Section'));
    });
  });

  describe('estimatePromptCost', () => {
    it('should estimate cost in USD', () => {
      const cost = estimatePromptCost(10000, 2000);

      assert.ok(Math.abs(cost.inputCost - 0.15) < 0.01); // $15/MTok * 10k = $0.15
      assert.ok(Math.abs(cost.outputCost - 0.15) < 0.01); // $75/MTok * 2k = $0.15
      assert.ok(Math.abs(cost.totalCost - 0.30) < 0.01);
    });

    it('should handle default completion tokens', () => {
      const cost = estimatePromptCost(5000);

      assert.ok(cost.inputCost > 0);
      assert.ok(cost.outputCost > 0);
      assert.equal(cost.totalCost, cost.inputCost + cost.outputCost);
    });
  });

  describe('extractGoalPatterns', () => {
    it('returns empty array for empty context', () => {
      const hints = extractGoalPatterns('');
      assert.deepEqual(hints, []);
    });

    it('extracts completed goal entries from LEARNED PATTERNS context', () => {
      const context = `LEARNED PATTERNS:
- Completed: "Add summarizer goal-history test" — modified src/server/db-helpers.ts
- Completed: "Wire goal cycling into ws-handler" — modified src/server/ws-handler.ts`;

      const hints = extractGoalPatterns(context);
      assert.ok(hints.length >= 2, 'Should extract both completed goal entries');
      const names = hints.map(h => h.suggestedGoal);
      assert.ok(names.some(n => n.includes('Add summarizer goal-history test')), 'Should extract first goal name');
      assert.ok(names.some(n => n.includes('Wire goal cycling into ws-handler')), 'Should extract second goal name');
    });

    it('extracts pattern entries', () => {
      const context = `LEARNED PATTERNS:
- Pattern: Always validate types before committing
- Pattern: Run tests before marking task complete`;

      const hints = extractGoalPatterns(context);
      assert.ok(hints.length >= 2, 'Should extract both pattern entries');
      const patterns = hints.map(h => h.pattern);
      assert.ok(patterns.some(p => p.includes('Always validate types')), 'Should extract first pattern');
      assert.ok(patterns.some(p => p.includes('Run tests before marking')), 'Should extract second pattern');
    });

    it('counts frequency for duplicate entries', () => {
      const context = `LEARNED PATTERNS:
- Completed: "Fix failing tests" — modified src/server/index.ts
- Completed: "Fix failing tests" — modified src/server/autopilot.ts`;

      const hints = extractGoalPatterns(context);
      const fixHint = hints.find(h => h.pattern.includes('Fix failing tests'));
      assert.ok(fixHint, 'Should find the duplicated goal entry');
      assert.equal(fixHint?.frequency, 2, 'Frequency should be 2 for duplicate entry');
    });

    it('sorts hints by frequency descending', () => {
      const context = `LEARNED PATTERNS:
- Completed: "Common Goal" — file1
- Completed: "Common Goal" — file2
- Completed: "Rare Goal" — file3`;

      const hints = extractGoalPatterns(context);
      assert.ok(hints.length >= 2);
      assert.ok(hints[0].frequency >= hints[1].frequency, 'Should be sorted by frequency descending');
      assert.ok(hints[0].pattern.includes('Common Goal'), 'Most frequent should be first');
    });

    it('truncates long patterns to 80 chars in suggestedGoal', () => {
      const longText = 'A'.repeat(100);
      const context = `LEARNED PATTERNS:\n- Pattern: ${longText}`;

      const hints = extractGoalPatterns(context);
      assert.ok(hints.length >= 1, 'Should extract the long pattern');
      assert.ok(hints[0].suggestedGoal.length <= 80, 'suggestedGoal should be truncated to 80 chars');
      assert.ok(hints[0].pattern.length > 80, 'Original pattern should be preserved');
    });

    it('each hint has correct shape: pattern, frequency, suggestedGoal', () => {
      const context = `LEARNED PATTERNS:
- Completed: "Improve test coverage" — src/server/__tests__/
- Pattern: Run build before committing`;

      const hints = extractGoalPatterns(context);
      assert.ok(hints.length >= 2, 'Should extract at least 2 hints');

      for (const hint of hints) {
        assert.ok(typeof hint.pattern === 'string' && hint.pattern.length > 0, 'hint.pattern should be non-empty string');
        assert.ok(typeof hint.frequency === 'number' && hint.frequency >= 1, 'hint.frequency should be >= 1');
        assert.ok(typeof hint.suggestedGoal === 'string' && hint.suggestedGoal.length > 0, 'hint.suggestedGoal should be non-empty string');
      }
    });

    it('ignores non-pattern lines (task lists, rules, etc.)', () => {
      const context = `RULES:
1. Make small focused changes
2. Always run the build

PENDING TASKS:
- Fix the bug in auth module
- Update database schema`;

      const hints = extractGoalPatterns(context);
      // Rules and task list items should not produce pattern hints
      assert.equal(hints.length, 0, 'Should not extract non-pattern lines as hints');
    });

    it('works with mixed completed and pattern entries', () => {
      const context = `PAST MISTAKES:
- Tests failed: not ok 1 - agent-memory.test.ts → Fix: Run tests before committing

LEARNED PATTERNS:
- Completed: "Verify test suite passes clean" — modified src/server/__tests__/autopilot-goal-cycling.test.ts
- Pattern: Before starting any task, verify current state with git status`;

      const hints = extractGoalPatterns(context);
      assert.ok(hints.length >= 2, 'Should extract both completed goal and pattern');
    });
  });

  describe('detectGoalGap', () => {
    it('returns hasGap=false when pending tasks exist', () => {
      const context = `Pending tasks:
- Fix auth bug: Update src/server/auth.ts to handle token expiry
- Add logging: Extend src/server/logger.ts with structured output`;

      const signal = detectGoalGap(context);
      assert.equal(signal.hasGap, false, 'Should not report gap when tasks exist');
      assert.ok(signal.pendingTaskCount >= 2, 'Should count pending tasks');
    });

    it('returns hasGap=true when explicit "no active goals" phrase present', () => {
      const context = `No active goals remain. The agent should propose new goals based on past patterns.`;

      const signal = detectGoalGap(context);
      assert.equal(signal.hasGap, true, 'Should detect gap from explicit phrase');
      assert.ok(signal.reason.includes('no active goals'), 'Reason should mention the phrase');
      assert.equal(signal.activeGoalCount, 0);
    });

    it('returns hasGap=true when pending tasks section is empty', () => {
      const context = `Recent progress:
- [OK] goal_completed: Finished all tasks

Pending tasks:

RULES:
1. Make small changes`;

      const signal = detectGoalGap(context);
      assert.equal(signal.hasGap, true, 'Should detect gap when pending section is empty');
    });

    it('returns hasGap=true when goal-gap keyword appears', () => {
      const context = `goal-gap detected: no further goals to cycle through`;

      const signal = detectGoalGap(context);
      assert.equal(signal.hasGap, true, 'Should detect gap from goal-gap keyword');
    });

    it('returns hasGap=false for normal autopilot context with tasks', () => {
      const context = `You are working autonomously on this goal: "Improve test coverage"

Pending tasks:
- Add scheduler tests: Create src/server/__tests__/scheduler.test.ts
- Test agent-memory: Extend src/server/__tests__/agent-memory.test.ts

RULES:
1. Make small changes
2. Run build after changes`;

      const signal = detectGoalGap(context);
      assert.equal(signal.hasGap, false, 'Should not report gap in normal autopilot context');
      assert.ok(signal.reason.includes('pending task'), 'Reason should mention pending tasks');
    });

    it('signal has correct shape: hasGap, reason, activeGoalCount, pendingTaskCount', () => {
      const context = `No more active goals — proposing new goals.`;

      const signal = detectGoalGap(context);
      assert.equal(typeof signal.hasGap, 'boolean');
      assert.equal(typeof signal.reason, 'string');
      assert.ok(signal.reason.length > 0);
      assert.equal(typeof signal.activeGoalCount, 'number');
      assert.equal(typeof signal.pendingTaskCount, 'number');
      assert.ok(signal.activeGoalCount >= 0);
      assert.ok(signal.pendingTaskCount >= 0);
    });

    it('handles empty context gracefully', () => {
      const signal = detectGoalGap('');
      assert.equal(signal.hasGap, false, 'Empty context should not be a gap');
      assert.equal(signal.pendingTaskCount, 0);
    });
  });

  describe('real prompt analysis', () => {
    it('should analyze a typical autopilot planning prompt', () => {
      // Simulating buildPlanningPrompt output
      const prompt = `LEARNED PATTERNS:
- Completed: "Make active indicator larger and more visible" — modified .gitignore
- Completed: "Add glow effect to active indicator" — modified src/client/components/BottomNav.tsx

You are working autonomously on this goal: "Self-improving autopilot pipeline"
Description: You are an autonomous agent whose job is to make yourself better at your job.

IMPORTANT: Stay focused on this specific goal. Do not work on unrelated improvements.

Planning tasks for goal: "Self-improving autopilot pipeline"

Use Glob on src/server/, then output 3-5 tasks. Max 1-2 tool calls. Do NOT read files.

FORMAT (one per line):
TASK: <title> | <description with file names>

Examples:
TASK: Add scheduler tests | Create src/server/__tests__/scheduler.test.ts testing matchesCron
TASK: Test agent-memory | Create src/server/__tests__/agent-memory.test.ts testing recordMistake

Each task = 1 run (1-2 file edits). Name exact files. Plan only, don't implement.`;

      const analysis = analyzePrompt(prompt);

      console.log('\n=== Planning Prompt Analysis ===');
      console.log(`Total tokens: ${analysis.totalTokens}`);
      console.log('\nTop sections:');
      analysis.sections
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 5)
        .forEach(s => {
          console.log(`  ${s.name}: ${s.tokens} tokens (${s.percentage}%)`);
        });

      if (analysis.redundancies.length > 0) {
        console.log('\nRedundancies found:');
        analysis.redundancies.forEach(r => console.log(`  - ${r}`));
      }

      assert.ok(analysis.totalTokens > 0);
    });

    it('should analyze a typical autopilot implementation prompt', () => {
      // Simulating buildAutopilotPrompt output
      const prompt = `LEARNED PATTERNS:
- Completed: "Cache expensive git operations" — modified src/server/git-utils.ts

AREAS TO IMPROVE:
- [speed] Reduce redundant file reads
- [cost] Minimize repeated context in prompts

LESSONS FROM RECENT RUNS:
- Worked well: Used cached queries for goal_log
- To improve: Build validation takes too long
- Pattern: Most tasks only touch 1-2 files

AVAILABLE SKILLS:
- DB Query Caching: Cache frequently accessed database queries
  Snippet: const cache = new Map(); function getCached(key...

You are working autonomously on this goal: "Self-improving autopilot pipeline"
Description: You are an autonomous agent whose job is to make yourself better at your job.

WHAT YOU KNOW ABOUT YOURSELF:
- You are spawned as a fresh Claude Code session each run (no memory between runs)
- Your past behavior is recorded in: goal_log table, .boof/memory.json, tasks table
- You run on a Windows machine, server at src/server/, client at src/client/

WHAT TO WORK ON (pick ONE per run, measure before/after):
- Speed: How long does each run take?
- Cost: Can you reduce token usage?
- Quality: Are your changes correct on the first try?

HOW TO MEASURE:
- Before making changes, query goal_log
- After your run, the system logs your results automatically

IMPORTANT: Stay focused on this specific goal. Do not work on unrelated improvements.

Recent progress:
- [OK] planning: Decomposed goal into 4 tasks
- [OK] task_created: Created task: Optimize memory context

Pending tasks:
- Optimize memory context: Refactor agent-memory.ts to return fewer items
- Test branch-guard: Create tests for branch-guard.ts

RULES:
1. Make SMALL, focused changes — edit 1-2 files max per run.
2. After making changes, ALWAYS run the build: node node_modules/vite/bin/vite.js build
   Do NOT use "npm run build" — vite is not in cmd.exe PATH on this Windows system.
3. If the build fails, fix the errors before finishing.
4. Keep your changes focused and testable.

Pick the most impactful pending task, implement it, and verify the build passes.

FOCUS ON THIS TASK: Optimize memory context
Details: Refactor agent-memory.ts to return fewer items`;

      const analysis = analyzePrompt(prompt);
      const cost = estimatePromptCost(analysis.totalTokens);

      console.log('\n=== Implementation Prompt Analysis ===');
      console.log(`Total tokens: ${analysis.totalTokens}`);
      console.log(`Estimated cost per run: $${cost.totalCost.toFixed(4)}`);
      console.log(`  Input: $${cost.inputCost.toFixed(4)}`);
      console.log(`  Output: $${cost.outputCost.toFixed(4)}`);
      console.log('\nTop sections:');
      analysis.sections
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 5)
        .forEach(s => {
          console.log(`  ${s.name}: ${s.tokens} tokens (${s.percentage}%)`);
        });

      if (analysis.redundancies.length > 0) {
        console.log('\nRedundancies found:');
        analysis.redundancies.forEach(r => console.log(`  - ${r}`));
      }

      if (analysis.recommendations.length > 0) {
        console.log('\nRecommendations:');
        analysis.recommendations.forEach(r => console.log(`  - ${r}`));
      }

      assert.ok(analysis.totalTokens > 0);
      assert.ok(cost.totalCost > 0);
    });
  });
});
