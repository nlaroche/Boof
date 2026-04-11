/**
 * Branch protection guard — prevents agent commits on protected branches.
 */

const PROTECTED_BRANCHES = new Set([
  'main',
  'master',
  'develop',
  'production',
  'staging',
]);

export function isProtectedBranch(name: string): boolean {
  return PROTECTED_BRANCHES.has(name);
}

export function assertNotProtected(name: string): void {
  if (PROTECTED_BRANCHES.has(name)) {
    throw new Error(`Refusing to operate on protected branch: ${name}`);
  }
}

/** Check if a branch is a goal branch (goal/{slug}) */
export function isGoalBranch(name: string): boolean {
  return name.startsWith('goal/');
}

/** Check if a branch is an agent branch (agent/{name}/{slug}) */
export function isAgentBranch(name: string): boolean {
  return name.startsWith('agent/');
}

/**
 * Check if direct commits are allowed on this branch.
 * Protected branches: never. Goal branches: only during revision/healing.
 * Agent branches: always.
 */
export function canCommitTo(name: string, context?: { isRevision?: boolean; isHealing?: boolean }): boolean {
  if (isProtectedBranch(name)) return false;
  if (isGoalBranch(name)) return !!(context?.isRevision || context?.isHealing);
  if (isAgentBranch(name)) return true;
  return false;
}
