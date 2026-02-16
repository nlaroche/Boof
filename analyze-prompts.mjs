/**
 * Standalone script to analyze autopilot prompt token overhead.
 * Run with: node analyze-prompts.mjs
 */

// Simple token estimator (4 chars ≈ 1 token)
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function analyzePrompt(name, prompt) {
  const tokens = estimateTokens(prompt);
  const lines = prompt.split('\n');

  console.log(`\n=== ${name} ===`);
  console.log(`Total characters: ${prompt.length}`);
  console.log(`Estimated tokens: ${tokens}`);
  console.log(`Lines: ${lines.length}`);

  // Break down by sections
  const sections = {};
  let currentSection = 'Intro';
  let currentContent = '';

  for (const line of lines) {
    // Detect major section headers
    if (line.match(/^[A-Z\s]+:$/) || line.match(/^LEARNED PATTERNS:/) || line.match(/^WHAT TO WORK ON/)) {
      if (currentContent) {
        sections[currentSection] = currentContent;
      }
      currentSection = line.replace(':', '').trim() || currentSection;
      currentContent = '';
    } else {
      currentContent += line + '\n';
    }
  }

  // Add final section
  if (currentContent) {
    sections[currentSection] = currentContent;
  }

  console.log(`\nSection breakdown:`);
  const sectionData = Object.entries(sections).map(([name, content]) => ({
    name,
    chars: content.length,
    tokens: estimateTokens(content),
    lines: content.split('\n').length,
  })).sort((a, b) => b.tokens - a.tokens);

  for (const section of sectionData) {
    const percentage = Math.round((section.tokens / tokens) * 100);
    console.log(`  ${section.name.padEnd(35)} ${section.tokens.toString().padStart(5)} tokens (${percentage}%) - ${section.lines} lines`);
  }

  // Detect redundancies
  const redundancies = [];
  const lower = prompt.toLowerCase();

  if ((lower.match(/always/g) || []).length > 3) {
    redundancies.push('Excessive "ALWAYS" usage');
  }

  if ((lower.match(/important/g) || []).length > 2) {
    redundancies.push('Multiple IMPORTANT markers');
  }

  const goalMatches = lower.match(/goal:/g);
  if (goalMatches && goalMatches.length > 2) {
    redundancies.push(`Goal mentioned ${goalMatches.length} times`);
  }

  if (lower.includes('windows') && lower.includes('cmd.exe')) {
    const windowsLines = lines.filter(l =>
      l.toLowerCase().includes('windows') ||
      l.toLowerCase().includes('cmd.exe') ||
      l.toLowerCase().includes('vite.js') ||
      l.toLowerCase().includes('path on this')
    );
    if (windowsLines.length > 2) {
      redundancies.push(`${windowsLines.length} lines of Windows-specific instructions`);
    }
  }

  if (redundancies.length > 0) {
    console.log(`\nDetected redundancies:`);
    for (const r of redundancies) {
      console.log(`  ⚠ ${r}`);
    }
  }

  // Cost estimate (Claude Opus 4.6: $15/MTok input, $75/MTok output)
  const inputCost = (tokens / 1_000_000) * 15;
  const outputCost = (2000 / 1_000_000) * 75; // Assume 2k completion
  const totalCost = inputCost + outputCost;

  console.log(`\nCost estimate per run:`);
  console.log(`  Input:  $${inputCost.toFixed(4)} (${tokens} tokens)`);
  console.log(`  Output: $${outputCost.toFixed(4)} (2000 tokens est.)`);
  console.log(`  Total:  $${totalCost.toFixed(4)}`);

  return { tokens, sections: sectionData, redundancies };
}

// Simulate typical planning prompt
const planningPrompt = `LEARNED PATTERNS:
- Completed: "Make active indicator larger and more visible" — modified .gitignore, src/client/components/BottomNav.tsx, src/server/autopilot.ts, src/server/pty-manager.ts
- Completed: "Add glow effect to active indicator" — modified .gitignore, src/client/components/BottomNav.tsx
- Completed: "Add transition animation to indicator" — modified .gitignore, src/client/components/BottomNav.tsx
- Completed: "Adjust indicator position for better alignment" — modified .gitignore, src/client/components/BottomNav.tsx
- Completed: "Simplify to single indicator element" — modified .gitignore, src/client/components/BottomNav.tsx

Planning tasks for goal: "Self-improving autopilot pipeline"
You are an autonomous agent whose job is to make yourself better at your job.

Use Glob on src/server/, then output 3-5 tasks. Max 1-2 tool calls. Do NOT read files.

FORMAT (one per line):
TASK: <title> | <description with file names>

Examples:
TASK: Add scheduler tests | Create src/server/__tests__/scheduler.test.ts testing matchesCron
TASK: Test agent-memory | Create src/server/__tests__/agent-memory.test.ts testing recordMistake

Each task = 1 run (1-2 file edits). Name exact files. Plan only, don't implement.`;

// Simulate typical implementation prompt
const implementationPrompt = `LEARNED PATTERNS:
- Completed: "Make active indicator larger and more visible" — modified .gitignore, src/client/components/BottomNav.tsx
- Completed: "Add glow effect to active indicator" — modified .gitignore, src/client/components/BottomNav.tsx
- Completed: "Cache expensive git operations" — modified src/server/__tests__/git-utils-cache.test.ts, src/server/autopilot.ts, src/server/git-utils.ts

AREAS TO IMPROVE:
- [speed] Reduce redundant file reads during planning phase
- [cost] Minimize repeated context in task prompts
- [quality] Add more validation before committing

LESSONS FROM RECENT RUNS:
- Worked well: Using cached goal_log queries reduced DB overhead
- To improve: Build validation phase takes 30% of total runtime
- Pattern: Most successful tasks only touch 1-2 files

AVAILABLE SKILLS:
- DB Query Caching: Cache frequently accessed database queries to reduce overhead
  Snippet: const cache = new Map(); function getCached(key, fetcher) { if (!cache.has(key)) cache.set...

You are working autonomously on this goal: "Self-improving autopilot pipeline"
Description: You are an autonomous agent whose job is to make yourself better at your job.

You run inside Boof — a system where you get a goal, plan tasks, implement them, and your code gets merged if the build passes. Your goal is to make this entire loop faster, cheaper, smarter, and more autonomous.

WHAT YOU KNOW ABOUT YOURSELF:
- You are spawned as a fresh Claude Code session each run (no memory between runs)
- Your past behavior is recorded in: goal_log table, .boof/memory.json, tasks table
- You run on a Windows machine, server at src/server/, client at src/client/
- You can modify your own source code (autopilot.ts, agent-providers.ts, pty-manager.ts, etc.)
- Successful runs get auto-merged to main. Failed builds get discarded.
- You have access to the internet (WebSearch, WebFetch tools)

WHAT TO WORK ON (pick ONE per run, measure before/after):
- Speed: How long does each run take? Can you make prompts more focused? Reduce unnecessary tool calls?
- Cost: Can you reduce token usage? Use cheaper models for subtasks? Cache common lookups?
- Quality: Are your changes correct on the first try? What patterns cause build failures?
- Autonomy: Can you go longer without human intervention? Handle edge cases gracefully?
- Intelligence: Research how other AI agent systems work. Read papers, blog posts, open source projects. Apply what you learn.

HOW TO MEASURE:
- Before making changes, query goal_log: SELECT action, success, duration_ms FROM goal_log ORDER BY created_at DESC LIMIT 10
- After your run, the system logs your results automatically
- Read .boof/memory.json for patterns and mistakes from past runs
- Use git log to see what previous runs changed

IMPORTANT: Stay focused on this specific goal. Do not work on unrelated improvements.

Recent progress:
- [OK] planning: Decomposed goal into 4 tasks
- [OK] task_created: Created task: Optimize memory context injection
- [OK] task_created: Created task: Test branch-guard module
- [FAILED] task: Build failed with TS2304 error

Pending tasks:
- Analyze autopilot prompt overhead: Measure token count in autopilot.ts prompts and identify redundant context
- Optimize memory context injection: Refactor agent-memory.ts getMemoryContext to return only last 5 relevant mistakes
- Strip unnecessary context from task prompts: Remove redundant instructions from task assignment prompts
- Test branch-guard module: Create src/server/__tests__/branch-guard.test.ts testing isSafeBranch

RULES:
1. Make SMALL, focused changes — edit 1-2 files max per run.
2. After making changes, ALWAYS run the build: node node_modules/vite/bin/vite.js build
   Do NOT use "npm run build" — vite is not in cmd.exe PATH on this Windows system.
3. If the build fails, fix the errors before finishing.
4. Keep your changes focused and testable.

Pick the most impactful pending task, implement it, and verify the build passes.

FOCUS ON THIS TASK: Analyze autopilot prompt overhead
Details: Measure token count in autopilot.ts prompts and identify redundant context being sent to Claude Code

IMPORTANT: Implement the changes directly. Do NOT enter plan mode, do NOT just describe what to do, do NOT ask for confirmation. Read the relevant files, make the code changes using Edit/Write tools, and verify the result. Act autonomously and complete the task fully.`;

// Run analysis
const planResult = analyzePrompt('PLANNING PROMPT', planningPrompt);
const implResult = analyzePrompt('IMPLEMENTATION PROMPT', implementationPrompt);

// Summary comparison
console.log('\n=== SUMMARY COMPARISON ===');
console.log(`Planning prompt:        ${planResult.tokens} tokens`);
console.log(`Implementation prompt:  ${implResult.tokens} tokens`);
console.log(`\nTop optimization targets:`);

// Combine all sections and find biggest ones
const allSections = [...planResult.sections, ...implResult.sections];
const uniqueSections = new Map();
for (const section of allSections) {
  const existing = uniqueSections.get(section.name);
  if (!existing || section.tokens > existing.tokens) {
    uniqueSections.set(section.name, section);
  }
}

const topSections = Array.from(uniqueSections.values())
  .sort((a, b) => b.tokens - a.tokens)
  .slice(0, 5);

for (let i = 0; i < topSections.length; i++) {
  const section = topSections[i];
  console.log(`  ${i + 1}. ${section.name}: ${section.tokens} tokens`);
}

// Calculate potential savings
console.log(`\n=== OPTIMIZATION OPPORTUNITIES ===`);

const learnedPatterns = implResult.sections.find(s => s.name === 'LEARNED PATTERNS');
if (learnedPatterns && learnedPatterns.tokens > 200) {
  const savings = learnedPatterns.tokens - 200; // Keep only ~50 tokens (last 3-5 patterns)
  console.log(`1. Limit LEARNED PATTERNS to last 5 entries:`);
  console.log(`   Current: ${learnedPatterns.tokens} tokens`);
  console.log(`   Target:  ~200 tokens`);
  console.log(`   Savings: ~${savings} tokens per run`);
}

const whatToWorkOn = implResult.sections.find(s => s.name.includes('WHAT TO WORK ON'));
if (whatToWorkOn) {
  console.log(`\n2. "WHAT TO WORK ON" is repeated every run:`);
  console.log(`   Current: ${whatToWorkOn.tokens} tokens`);
  console.log(`   Solution: Move to goal description (loaded once)`);
  console.log(`   Savings: ${whatToWorkOn.tokens} tokens per run`);
}

const windowsLines = implementationPrompt.split('\n').filter(l =>
  l.toLowerCase().includes('windows') ||
  l.toLowerCase().includes('cmd.exe') ||
  l.toLowerCase().includes('vite.js') ||
  l.toLowerCase().includes('path on this')
);
if (windowsLines.length > 0) {
  const windowsTokens = estimateTokens(windowsLines.join('\n'));
  console.log(`\n3. Windows-specific build instructions:`);
  console.log(`   Current: ${windowsTokens} tokens (${windowsLines.length} lines)`);
  console.log(`   Solution: Move to CLAUDE.md context`);
  console.log(`   Savings: ${windowsTokens} tokens per run`);
}

console.log(`\n=== TOTAL ESTIMATED SAVINGS ===`);
const totalSavings = (learnedPatterns ? learnedPatterns.tokens - 200 : 0) +
  (whatToWorkOn ? whatToWorkOn.tokens : 0) +
  (windowsLines.length > 0 ? estimateTokens(windowsLines.join('\n')) : 0);
const percentageSaved = Math.round((totalSavings / implResult.tokens) * 100);
const costSavings = (totalSavings / 1_000_000) * 15; // Input token cost

console.log(`Per run:     ~${totalSavings} tokens (${percentageSaved}%)`);
console.log(`Per 100 runs: ~$${(costSavings * 100).toFixed(2)} saved`);
console.log(`Per 1000 runs: ~$${(costSavings * 1000).toFixed(2)} saved`);
