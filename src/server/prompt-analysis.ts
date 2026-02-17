/**
 * Utility to analyze and measure token overhead in autopilot prompts.
 *
 * This module helps identify redundant context being sent to Claude Code
 * and provides metrics for optimization.
 */

// Simple token estimator (4 chars ≈ 1 token for English text)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

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
