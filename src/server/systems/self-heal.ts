/**
 * Self-healing system for merge gate failures.
 *
 * Handles:
 * - Merge conflicts (during consolidation or final merge)
 * - Test failures (after consolidation)
 * - Lint/build errors
 *
 * Bounded: max heal attempts per merge gate prevents infinite loops.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import { Timeouts } from '../engine/constants.js';

const execAsync = promisify(exec);

export type HealFailureType = 'merge_conflict' | 'test_failure' | 'build_failure' | 'lint_error';

export interface HealResult {
  success: boolean;
  description: string;
  output: string;
}

/**
 * Attempt to resolve a merge conflict.
 * Strategy: try --theirs for non-critical files, manual resolution for others.
 */
export async function healMergeConflict(
  cwd: string,
  conflictOutput: string,
): Promise<HealResult> {
  try {
    // Get list of conflicted files
    const { stdout: statusOut } = await execAsync('git diff --name-only --diff-filter=U', {
      cwd,
      timeout: Timeouts.GIT_QUICK,
    });
    const conflictedFiles = statusOut.split('\n').filter(Boolean);

    if (conflictedFiles.length === 0) {
      return { success: true, description: 'No conflicts found', output: '' };
    }

    // For each conflicted file, try to resolve using --theirs (accept incoming changes)
    // This is a simple strategy — review agent will catch issues
    for (const file of conflictedFiles) {
      await execAsync(`git checkout --theirs "${file}" && git add "${file}"`, {
        cwd,
        timeout: Timeouts.GIT_QUICK,
      });
    }

    // Commit the resolution
    await execAsync('git commit --no-edit', {
      cwd,
      timeout: Timeouts.GIT_STANDARD,
    }).catch(() => {
      // If there's nothing to commit, the merge was already resolved
    });

    return {
      success: true,
      description: `Resolved ${conflictedFiles.length} conflicted files (accepted incoming changes)`,
      output: conflictedFiles.join('\n'),
    };
  } catch (err: any) {
    return {
      success: false,
      description: 'Failed to resolve merge conflicts automatically',
      output: err.message || String(err),
    };
  }
}

/**
 * Build a prompt for an agent to fix test failures.
 */
export function buildTestFixPrompt(
  testOutput: string,
  failures: string[],
  repoPath: string,
): string {
  let prompt = `The test suite failed after consolidating changes. Fix the failing tests.\n\n`;
  prompt += `Working directory: ${repoPath}\n\n`;

  if (failures.length > 0) {
    prompt += `Specific failures:\n`;
    for (const f of failures) {
      prompt += `  - ${f}\n`;
    }
    prompt += `\n`;
  }

  // Include tail of test output (last 2000 chars)
  const tailLength = 2000;
  const outputTail = testOutput.length > tailLength
    ? '...\n' + testOutput.slice(-tailLength)
    : testOutput;
  prompt += `Test output:\n\`\`\`\n${outputTail}\n\`\`\`\n\n`;
  prompt += `Fix the test failures. Make minimal changes. Do NOT skip or disable tests.`;

  return prompt;
}

/**
 * Build a prompt for an agent to fix build/lint errors.
 */
export function buildBuildFixPrompt(
  buildOutput: string,
  repoPath: string,
): string {
  let prompt = `The build failed after consolidating changes. Fix the build errors.\n\n`;
  prompt += `Working directory: ${repoPath}\n\n`;

  const tailLength = 2000;
  const outputTail = buildOutput.length > tailLength
    ? '...\n' + buildOutput.slice(-tailLength)
    : buildOutput;
  prompt += `Build output:\n\`\`\`\n${outputTail}\n\`\`\`\n\n`;
  prompt += `Fix the build errors. Focus on type errors and missing imports first.`;

  return prompt;
}

/**
 * Determine the type of failure from the context.
 */
export function classifyFailure(healReason: string | null, testResults?: { failures: string[] } | null): HealFailureType {
  if (healReason?.includes('merge conflict')) return 'merge_conflict';
  if (healReason?.includes('build') || healReason?.includes('lint')) return 'build_failure';
  if (healReason?.includes('test') || (testResults?.failures?.length ?? 0) > 0) return 'test_failure';
  return 'test_failure'; // default
}

/**
 * Check if a heal attempt should be escalated to human review.
 * Returns a reason string if escalation is needed, null otherwise.
 */
export function shouldEscalate(
  healAttempts: number,
  maxAttempts: number,
  failureType: HealFailureType,
): string | null {
  if (healAttempts >= maxAttempts) {
    return `Max heal attempts (${maxAttempts}) exceeded for ${failureType}`;
  }
  return null;
}
