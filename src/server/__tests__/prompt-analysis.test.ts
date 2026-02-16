import { describe, it, expect } from 'vitest';
import {
  analyzePrompt,
  comparePrompts,
  generatePromptReport,
  estimatePromptCost,
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

      expect(analysis.totalTokens).toBeGreaterThan(0);
      expect(analysis.sections.length).toBeGreaterThan(0);
      expect(analysis.sections.every(s => s.percentage >= 0)).toBe(true);
    });

    it('should detect redundant "ALWAYS" usage', () => {
      const prompt = `ALWAYS do this. ALWAYS do that. ALWAYS remember. ALWAYS check.`;

      const analysis = analyzePrompt(prompt);

      expect(analysis.redundancies).toContain(
        'Excessive use of "ALWAYS" - consider consolidating rules'
      );
    });

    it('should detect multiple IMPORTANT markers', () => {
      const prompt = `IMPORTANT: Do this. IMPORTANT: Also this. IMPORTANT: And this.`;

      const analysis = analyzePrompt(prompt);

      expect(analysis.redundancies.some(r => r.includes('IMPORTANT'))).toBe(true);
    });

    it('should detect repeated goal mentions', () => {
      const prompt = `Goal: Test\nWorking on goal: Test\nFor this goal: Test`;

      const analysis = analyzePrompt(prompt);

      expect(analysis.redundancies.some(r => r.includes('Goal mentioned'))).toBe(true);
    });

    it('should recommend reducing large sections', () => {
      const largeContent = 'A'.repeat(4000); // ~1000 tokens
      const prompt = `LEARNED PATTERNS:\n${largeContent}\n\nSome other content`;

      const analysis = analyzePrompt(prompt);

      expect(analysis.recommendations.length).toBeGreaterThan(0);
    });
  });

  describe('comparePrompts', () => {
    it('should calculate token savings', () => {
      const before = 'This is a long prompt with lots of content that we want to reduce';
      const after = 'Short prompt';

      const comparison = comparePrompts(before, after);

      expect(comparison.tokenSavings).toBeGreaterThan(0);
      expect(comparison.percentageReduction).toBeGreaterThan(0);
    });

    it('should detect removed sections', () => {
      const before = `RULES:\n1. Rule\n\nPATTERNS:\n- Pattern`;
      const after = `RULES:\n1. Rule`;

      const comparison = comparePrompts(before, after);

      expect(comparison.sectionsRemoved.length).toBeGreaterThan(0);
    });
  });

  describe('generatePromptReport', () => {
    it('should generate a readable report', () => {
      const prompt = `RULES:\nDo this\n\nGoal: Test\nDescription: Stuff`;

      const report = generatePromptReport(prompt);

      expect(report).toContain('PROMPT TOKEN ANALYSIS');
      expect(report).toContain('Total estimated tokens:');
      expect(report).toContain('Breakdown by Section');
    });
  });

  describe('estimatePromptCost', () => {
    it('should estimate cost in USD', () => {
      const cost = estimatePromptCost(10000, 2000);

      expect(cost.inputCost).toBeCloseTo(0.15, 2); // $15/MTok * 10k = $0.15
      expect(cost.outputCost).toBeCloseTo(0.15, 2); // $75/MTok * 2k = $0.15
      expect(cost.totalCost).toBeCloseTo(0.30, 2);
    });

    it('should handle default completion tokens', () => {
      const cost = estimatePromptCost(5000);

      expect(cost.inputCost).toBeGreaterThan(0);
      expect(cost.outputCost).toBeGreaterThan(0);
      expect(cost.totalCost).toBe(cost.inputCost + cost.outputCost);
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

      expect(analysis.totalTokens).toBeGreaterThan(0);
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

      expect(analysis.totalTokens).toBeGreaterThan(0);
      expect(cost.totalCost).toBeGreaterThan(0);
    });
  });
});
