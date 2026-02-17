/**
 * Utility to analyze and measure token overhead in autopilot prompts.
 *
 * This module helps identify redundant context being sent to Claude Code
 * and provides metrics for optimization.
 */
import { estimateTokens } from './db-helpers.js';

interface PromptSection {
  name: string;
  content: string;
  tokens: number;
  percentage: number;
}

interface PromptAnalysis {
  totalTokens: number;
  sections: PromptSection[];
  redundancies: string[];
  recommendations: string[];
}

/**
 * Analyze a prompt and break down token usage by section.
 */
export function analyzePrompt(prompt: string): PromptAnalysis {
  const sections: PromptSection[] = [];
  const redundancies: string[] = [];
  const recommendations: string[] = [];

  // Split prompt into logical sections
  const lines = prompt.split('\n');
  let currentSection = '';
  let currentContent = '';

  for (const line of lines) {
    // Detect section headers
    if (line.match(/^[A-Z\s]+:$/) || line.match(/^LEARNED PATTERNS:/)) {
      if (currentSection && currentContent) {
        const tokens = estimateTokens(currentContent);
        sections.push({
          name: currentSection,
          content: currentContent,
          tokens,
          percentage: 0, // Will calculate after
        });
      }
      currentSection = line.replace(':', '').trim();
      currentContent = '';
    } else {
      currentContent += line + '\n';
    }
  }

  // Add final section
  if (currentSection && currentContent) {
    const tokens = estimateTokens(currentContent);
    sections.push({
      name: currentSection,
      content: currentContent,
      tokens,
      percentage: 0,
    });
  }

  // If no sections detected, treat entire prompt as one section
  if (sections.length === 0) {
    sections.push({
      name: 'Full Prompt',
      content: prompt,
      tokens: estimateTokens(prompt),
      percentage: 100,
    });
  }

  const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);

  // Calculate percentages
  sections.forEach(s => {
    s.percentage = totalTokens > 0 ? Math.round((s.tokens / totalTokens) * 100) : 0;
  });

  // Detect redundancies
  const contentLower = prompt.toLowerCase();

  // Check for repeated instructions
  if ((contentLower.match(/always/g) || []).length > 3) {
    redundancies.push('Excessive use of "ALWAYS" - consider consolidating rules');
  }

  if ((contentLower.match(/important:/g) || []).length > 2) {
    redundancies.push('Multiple IMPORTANT markers - prioritize or consolidate');
  }

  if ((contentLower.match(/rules:/g) || []).length > 1) {
    redundancies.push('Multiple RULES sections - should be unified');
  }

  // Check for repeated goal descriptions
  const goalMatches = contentLower.match(/goal:/g);
  if (goalMatches && goalMatches.length > 1) {
    redundancies.push(`Goal mentioned ${goalMatches.length} times - consolidate`);
  }

  // Check for verbose patterns
  if (contentLower.includes('learned patterns:')) {
    const patternSection = sections.find(s => s.name === 'LEARNED PATTERNS');
    if (patternSection && patternSection.tokens > 1000) {
      redundancies.push('LEARNED PATTERNS section is large - consider limiting to most recent 10');
    }
  }

  // Generate recommendations
  const largestSections = sections
    .filter(s => s.percentage > 20)
    .sort((a, b) => b.tokens - a.tokens);

  if (largestSections.length > 0) {
    recommendations.push(
      `Largest section: "${largestSections[0].name}" (${largestSections[0].percentage}%, ${largestSections[0].tokens} tokens) - consider reducing`
    );
  }

  // Check for Windows-specific instructions
  if (contentLower.includes('windows') || contentLower.includes('cmd.exe')) {
    const windowsContent = lines.filter(l =>
      l.toLowerCase().includes('windows') ||
      l.toLowerCase().includes('cmd.exe') ||
      l.toLowerCase().includes('vite.js')
    ).join('\n');
    const windowsTokens = estimateTokens(windowsContent);
    if (windowsTokens > 100) {
      recommendations.push(
        `Windows-specific instructions: ${windowsTokens} tokens - could be extracted to CLAUDE.md context`
      );
    }
  }

  // Check for build instructions
  const buildLines = lines.filter(l => l.toLowerCase().includes('build'));
  if (buildLines.length > 2) {
    recommendations.push(
      'Build instructions repeated - consolidate into single instruction block'
    );
  }

  return {
    totalTokens,
    sections,
    redundancies,
    recommendations,
  };
}

/**
 * Compare two prompts and identify what changed.
 */
export function comparePrompts(
  before: string,
  after: string
): {
  tokenSavings: number;
  percentageReduction: number;
  sectionsRemoved: string[];
  sectionsAdded: string[];
} {
  const beforeTokens = estimateTokens(before);
  const afterTokens = estimateTokens(after);

  const beforeAnalysis = analyzePrompt(before);
  const afterAnalysis = analyzePrompt(after);

  const beforeSectionNames = new Set(beforeAnalysis.sections.map(s => s.name));
  const afterSectionNames = new Set(afterAnalysis.sections.map(s => s.name));

  const sectionsRemoved = Array.from(beforeSectionNames).filter(
    name => !afterSectionNames.has(name)
  );
  const sectionsAdded = Array.from(afterSectionNames).filter(
    name => !beforeSectionNames.has(name)
  );

  return {
    tokenSavings: beforeTokens - afterTokens,
    percentageReduction: beforeTokens > 0
      ? Math.round(((beforeTokens - afterTokens) / beforeTokens) * 100)
      : 0,
    sectionsRemoved,
    sectionsAdded,
  };
}

/**
 * Generate a detailed report of prompt token usage.
 */
export function generatePromptReport(prompt: string): string {
  const analysis = analyzePrompt(prompt);

  let report = `=== PROMPT TOKEN ANALYSIS ===\n\n`;
  report += `Total estimated tokens: ${analysis.totalTokens}\n`;
  report += `Total characters: ${prompt.length}\n\n`;

  report += `--- Breakdown by Section ---\n`;
  for (const section of analysis.sections.sort((a, b) => b.tokens - a.tokens)) {
    report += `${section.name.padEnd(30)} ${section.tokens.toString().padStart(5)} tokens (${section.percentage}%)\n`;
  }

  if (analysis.redundancies.length > 0) {
    report += `\n--- Detected Redundancies ---\n`;
    for (const redundancy of analysis.redundancies) {
      report += `- ${redundancy}\n`;
    }
  }

  if (analysis.recommendations.length > 0) {
    report += `\n--- Optimization Recommendations ---\n`;
    for (const rec of analysis.recommendations) {
      report += `- ${rec}\n`;
    }
  }

  return report;
}

// ============================================================================
// Goal Pattern Extraction
// ============================================================================

export interface GoalPatternHint {
  pattern: string;
  frequency: number;
  suggestedGoal: string;
}

/**
 * Parse completed-goal history entries from the LEARNED PATTERNS section
 * of a prompt or memory context and extract proposal hints.
 *
 * Input format (typical entries):
 *   - Completed: "Goal name" — modified file1.ts, file2.ts
 *   - Pattern: Always validate types before committing
 *
 * Returns an array of hints that can be used to propose new goals.
 */
export function extractGoalPatterns(context: string): GoalPatternHint[] {
  const hints: GoalPatternHint[] = [];
  const seen = new Map<string, number>();

  const lines = context.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Match completed goal entries: - Completed: "Goal name" — ...
    const completedMatch = trimmed.match(/^[-*]?\s*Completed:\s*"([^"]+)"/i);
    if (completedMatch) {
      const goalName = completedMatch[1].trim();
      seen.set(goalName, (seen.get(goalName) ?? 0) + 1);
      continue;
    }

    // Match pattern entries: - Pattern: <text>
    const patternMatch = trimmed.match(/^[-*]?\s*Pattern:\s*(.+)$/i);
    if (patternMatch) {
      const pattern = patternMatch[1].trim();
      seen.set(pattern, (seen.get(pattern) ?? 0) + 1);
    }
  }

  for (const [text, frequency] of seen) {
    // Convert the completed goal / pattern into a proposal hint
    const suggestedGoal = text.length > 80 ? text.slice(0, 77) + '...' : text;
    hints.push({ pattern: text, frequency, suggestedGoal });
  }

  // Sort by frequency descending, then alphabetically for determinism
  hints.sort((a, b) => b.frequency - a.frequency || a.pattern.localeCompare(b.pattern));

  return hints;
}

// ============================================================================
// Goal Gap Detection
// ============================================================================

export interface GoalGapSignal {
  hasGap: boolean;
  reason: string;
  activeGoalCount: number;
  pendingTaskCount: number;
}

/**
 * Detect whether there is a "goal gap" — a state where no active goals remain
 * after cycling through completions. This signal is used by the autopilot to
 * trigger automatic goal proposal via agent memory patterns.
 *
 * Examines the memory context / planning prompt text for:
 *  - Active goal count (goals listed under "Pending tasks:" or similar)
 *  - Explicit "no active goals" / "no more goals" indicators
 */
export function detectGoalGap(context: string): GoalGapSignal {
  const lower = context.toLowerCase();

  // Count active goals by looking for goal/task markers
  const pendingMatches = context.match(/^[-*]\s+.+:/gm) || [];
  const pendingTaskCount = pendingMatches.length;

  // Look for explicit "no active goals" phrases
  const noGoalPhrases = [
    'no active goals',
    'no more active goals',
    'no goals remain',
    'no remaining goals',
    'no more goals',
  ];
  const explicitNoGoal = noGoalPhrases.some(phrase => lower.includes(phrase));

  // Check for the "Pending tasks:" section being empty
  // Find the line with "Pending tasks:" and check if the very next non-blank line starts a new section
  // If after "Pending tasks:\n" (with optional blank lines) there's immediately a section header or EOF
  const pendingLineCheck = context.match(/Pending tasks:[ \t]*\n(?:[ \t]*\n)*([A-Z][A-Z]+:|$)/);
  const pendingSectionEmpty = pendingLineCheck !== null;

  // Check for goal-gap keyword
  const hasGapKeyword = lower.includes('goal-gap') || lower.includes('goal gap');

  const hasGap = explicitNoGoal || pendingSectionEmpty || hasGapKeyword;

  let reason: string;
  if (hasGap) {
    if (explicitNoGoal) {
      reason = 'Explicit "no active goals" signal found in context';
    } else if (pendingSectionEmpty) {
      reason = 'Pending tasks section is empty — no tasks remain';
    } else {
      reason = 'Goal-gap keyword detected in context';
    }
  } else {
    reason = `${pendingTaskCount} pending task(s) found — no gap`;
  }

  return {
    hasGap,
    reason,
    activeGoalCount: hasGap ? 0 : Math.max(pendingTaskCount, 1),
    pendingTaskCount,
  };
}

/**
 * Estimate cost of a prompt (using Claude Opus 4.6 pricing).
 * Input: $15/MTok, Output: $75/MTok
 */
export function estimatePromptCost(
  promptTokens: number,
  expectedCompletionTokens: number = 2000
): { inputCost: number; outputCost: number; totalCost: number } {
  const inputCost = (promptTokens / 1_000_000) * 15;
  const outputCost = (expectedCompletionTokens / 1_000_000) * 75;

  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}
