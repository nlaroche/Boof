/**
 * Build and test execution for autopilot.
 *
 * Extracted from autopilot.ts to keep build/test operations focused.
 */
import { promisify } from 'util';
import { exec } from 'child_process';
import { Timeouts } from '../engine/constants.js';

const execAsync = promisify(exec);

/** Run the Vite build and return success/failure with output. */
export async function runBuildCheck(workingDirectory: string): Promise<{ success: boolean; output: string }> {
  try {
    const buildCmd = 'node node_modules/vite/bin/vite.js build';
    const { stdout, stderr } = await execAsync(buildCmd, {
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
  try {
    const testCmd = 'node --import tsx --test src/server/__tests__/*.test.ts src/server/engine/__tests__/*.test.ts';
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
    const failures = output.match(/not ok \d+ - .*/g) || [];
    return { success: false, output, failures };
  }
}
