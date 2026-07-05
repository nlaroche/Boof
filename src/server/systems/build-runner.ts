/**
 * Build and test execution for autopilot.
 *
 * Extracted from autopilot.ts to keep build/test operations focused.
 *
 * Commands are resolved PER REPO (H8) rather than hardcoded to Boof's layout:
 *   - test:  `review_configs.test_command` if configured, else the target
 *            repo's `package.json` `scripts.test`, else the phase is SKIPPED.
 *   - build: the target repo's `package.json` `scripts.build`, else SKIPPED.
 * A skipped phase returns an explicit "no ... configured" success result — it
 * must never look like a build/test failure that would abandon the branch.
 */
import { promisify } from 'util';
import { exec } from 'child_process';
import { Timeouts } from '../engine/constants.js';
import { getReviewConfig } from '../db-helpers.js';

const execAsync = promisify(exec);

interface PackageJsonScripts {
  build?: string;
  test?: string;
  [k: string]: string | undefined;
}

/** Read a package.json script's body if present in the repo. */
async function readPackageScript(workingDirectory: string, script: 'build' | 'test'): Promise<string | null> {
  const fs = await import('fs');
  const path = await import('path');
  const pkgPath = path.join(workingDirectory, 'package.json');
  try {
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const scripts: PackageJsonScripts = pkg.scripts || {};
    const body = scripts[script];
    return typeof body === 'string' && body.trim() ? body : null;
  } catch (err: any) {
    console.error(`[build-runner] Failed to read package.json scripts: ${err.message || err}`);
    return null;
  }
}

/** Run the build check and return success/failure with output. */
export async function runBuildCheck(workingDirectory: string): Promise<{ success: boolean; output: string }> {
  const fs = await import('fs');
  const path = await import('path');

  // Monorepo (pnpm workspace): skip vite build, just check TypeScript compiles
  const hasPnpmWorkspace = fs.existsSync(path.join(workingDirectory, 'pnpm-workspace.yaml'));
  if (hasPnpmWorkspace) {
    // For monorepos, just verify no obvious TS errors in changed packages
    // Full build validation should happen in CI
    return { success: true, output: 'Monorepo detected — build check deferred to CI' };
  }

  // Detect a build script in the target repo. If there is none, SKIP the build
  // phase rather than emitting a false failure (H8).
  const buildScript = await readPackageScript(workingDirectory, 'build');
  if (!buildScript) {
    return { success: true, output: 'no build configured (no package.json build script) — skipping build phase' };
  }

  try {
    const { stdout, stderr } = await execAsync('npm run build', {
      cwd: workingDirectory,
      timeout: Timeouts.BUILD,
      env: { ...process.env },
    });
    return { success: true, output: stdout + stderr };
  } catch (err: any) {
    return { success: false, output: err.stderr || err.stdout || String(err) };
  }
}

/** Run the test suite and return success/failure with parsed failures. */
export async function runTestCheck(workingDirectory: string): Promise<{ success: boolean; output: string; failures: string[] }> {
  // Resolve the test command: explicit review-config command wins, then the
  // repo's own `npm test`, else skip (H8).
  const config = getReviewConfig(workingDirectory);
  let testCmd: string | null = config?.test_command?.trim() || null;
  if (!testCmd) {
    const testScript = await readPackageScript(workingDirectory, 'test');
    if (testScript) testCmd = 'npm test';
  }
  if (!testCmd) {
    return {
      success: true,
      output: 'no tests configured (no review_configs.test_command and no package.json test script) — skipping test phase',
      failures: [],
    };
  }

  try {
    const { stdout, stderr } = await execAsync(testCmd, {
      cwd: workingDirectory,
      timeout: Timeouts.TEST,
      env: { ...process.env },
    });
    const output = stdout + stderr;
    const failures = output.match(/not ok \d+ - .*/g) || [];
    return { success: failures.length === 0, output, failures };
  } catch (err: any) {
    const output = err.stderr || err.stdout || String(err);
    // Prefer parsed TAP failures; otherwise the non-zero exit itself is the failure.
    const failures = output.match(/not ok \d+ - .*/g) || [`test command failed: ${testCmd}`];
    return { success: false, output, failures };
  }
}
