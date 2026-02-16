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
