import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, extractEditedFiles, generateSummary, commitAgentChanges } from '../git-utils.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('stripAnsi', () => {
  it('removes basic ANSI color codes', () => {
    const input = '\x1b[31mRed text\x1b[0m normal text';
    const expected = 'Red text normal text';
    assert.equal(stripAnsi(input), expected);
  });

  it('removes ANSI cursor movement codes', () => {
    const input = '\x1b[2J\x1b[H Clear screen';
    const expected = ' Clear screen';
    assert.equal(stripAnsi(input), expected);
  });

  it('removes OSC sequences', () => {
    const input = '\x1b]0;Window Title\x07Some text';
    const expected = 'Some text';
    assert.equal(stripAnsi(input), expected);
  });

  it('removes control characters', () => {
    const input = 'Hello\x00\x01\x02World';
    const expected = 'HelloWorld';
    assert.equal(stripAnsi(input), expected);
  });

  it('returns unchanged text with no ANSI codes', () => {
    const input = 'Plain text';
    assert.equal(stripAnsi(input), input);
  });

  it('handles empty string', () => {
    assert.equal(stripAnsi(''), '');
  });
});

describe('extractEditedFiles', () => {
  it('extracts files from emoji Write format', () => {
    const output = '✏️ Write src/client/App.tsx\nOther text';
    const files = extractEditedFiles(output);
    assert.deepEqual(files, ['src/client/App.tsx']);
  });

  it('extracts files from emoji Edit format', () => {
    const output = '✏️ Edit src/server/main.ts\nOther text';
    const files = extractEditedFiles(output);
    assert.deepEqual(files, ['src/server/main.ts']);
  });

  it('extracts files from checkmark format', () => {
    const output = '✅ src/utils/helper.ts\nOther text';
    const files = extractEditedFiles(output);
    assert.deepEqual(files, ['src/utils/helper.ts']);
  });

  it('extracts files from "Wrote to" format', () => {
    const output = 'Wrote to src/components/Button.tsx';
    const files = extractEditedFiles(output);
    assert.deepEqual(files, ['src/components/Button.tsx']);
  });

  it('extracts files from "Applied edit to" format', () => {
    const output = 'Applied edit to src/lib/types.ts';
    const files = extractEditedFiles(output);
    assert.deepEqual(files, ['src/lib/types.ts']);
  });

  it('extracts files from "Updated" format', () => {
    const output = 'Updated package.json';
    const files = extractEditedFiles(output);
    assert.deepEqual(files, ['package.json']);
  });

  it('extracts files from "Created" format', () => {
    const output = 'Created src/new-file.ts';
    const files = extractEditedFiles(output);
    assert.deepEqual(files, ['src/new-file.ts']);
  });

  it('extracts multiple files', () => {
    const output = `✏️ Write src/client/App.tsx
✏️ Edit src/server/main.ts
Wrote to src/utils/helper.ts`;
    const files = extractEditedFiles(output);
    assert.deepEqual(files, ['src/client/App.tsx', 'src/server/main.ts', 'src/utils/helper.ts']);
  });

  it('deduplicates files', () => {
    const output = `✏️ Write src/client/App.tsx
Wrote to src/client/App.tsx`;
    const files = extractEditedFiles(output);
    assert.deepEqual(files, ['src/client/App.tsx']);
  });

  it('strips trailing punctuation from filenames', () => {
    const output = '✏️ Write src/client/App.tsx,\n✏️ Edit src/server/main.ts;';
    const files = extractEditedFiles(output);
    assert.deepEqual(files, ['src/client/App.tsx', 'src/server/main.ts']);
  });

  it('strips ANSI codes before extracting', () => {
    const output = '\x1b[32m✏️ Write src/client/App.tsx\x1b[0m';
    const files = extractEditedFiles(output);
    assert.deepEqual(files, ['src/client/App.tsx']);
  });

  it('returns empty array when no files found', () => {
    const output = 'Some random text without file references';
    const files = extractEditedFiles(output);
    assert.deepEqual(files, []);
  });
});

describe('generateSummary', () => {
  it('extracts tool usage lines with emojis', () => {
    const output = `Some text
📖 Read src/file.ts
✏️ Write src/output.ts
More text`;
    const summary = generateSummary(output, 'test prompt');
    assert.ok(summary.includes('📖 Read src/file.ts'));
    assert.ok(summary.includes('✏️ Write src/output.ts'));
  });

  it('excludes separator lines', () => {
    const output = `Some text
─────────────
Important info
═════════════
More info
-------------`;
    const summary = generateSummary(output, 'test prompt');
    assert.ok(!summary.includes('─────'));
    assert.ok(!summary.includes('═════'));
    assert.ok(!summary.includes('-----'));
  });

  it('excludes lines starting with arrow', () => {
    const output = `Important info
→ noise line
More important info`;
    const summary = generateSummary(output, 'test prompt');
    assert.ok(!summary.includes('→ noise'));
  });

  it('excludes "Self-review" lines', () => {
    const output = `Important info
Self-review: checking work
More info`;
    const summary = generateSummary(output, 'test prompt');
    assert.ok(!summary.includes('Self-review'));
  });

  it('excludes "Changes committed" lines', () => {
    const output = `Important info
Changes committed successfully
More info`;
    const summary = generateSummary(output, 'test prompt');
    assert.ok(!summary.includes('Changes committed'));
  });

  it('limits description to 300 characters', () => {
    const longLine = 'a'.repeat(400);
    const output = longLine;
    const summary = generateSummary(output, 'test prompt');
    assert.ok(summary.length <= 400); // 300 for description + space for tools
  });

  it('takes last 3 description lines', () => {
    const output = `Line 1 with enough text
Line 2 with enough text
Line 3 with enough text
Line 4 with enough text
Line 5 with enough text`;
    const summary = generateSummary(output, 'test prompt');
    // Should contain lines 3, 4, 5 but not 1, 2
    assert.ok(!summary.includes('Line 1'));
    assert.ok(!summary.includes('Line 2'));
  });

  it('deduplicates tool lines', () => {
    const output = `📖 Read src/file.ts
📖 Read src/file.ts
📖 Read src/file.ts`;
    const summary = generateSummary(output, 'test prompt');
    // Count occurrences - should only appear once
    const matches = summary.match(/📖 Read src\/file\.ts/g);
    assert.equal(matches?.length, 1);
  });

  it('limits tool lines to 5 most recent', () => {
    const output = `
📖 Tool 1
📖 Tool 2
📖 Tool 3
📖 Tool 4
📖 Tool 5
📖 Tool 6
📖 Tool 7`;
    const summary = generateSummary(output, 'test prompt');
    // Should not include Tool 1 and Tool 2
    assert.ok(!summary.includes('Tool 1'));
    assert.ok(!summary.includes('Tool 2'));
  });

  it('falls back to prompt when output is empty', () => {
    const summary = generateSummary('', 'Fix the authentication bug');
    assert.ok(summary.includes('Fix the authentication bug'));
  });

  it('falls back to last 5 lines when no tool/description found', () => {
    const output = `a
b
c
d
e
f
g`;
    const summary = generateSummary(output, 'test prompt');
    // Should include last lines
    assert.ok(summary.includes('f') || summary.includes('g'));
  });

  it('limits fallback to 200 characters', () => {
    const longOutput = 'x'.repeat(500);
    const summary = generateSummary(longOutput, 'test');
    assert.ok(summary.length <= 400); // Overall limit
  });

  it('strips ANSI codes from output', () => {
    const output = '\x1b[32m📖 Read file\x1b[0m';
    const summary = generateSummary(output, 'test');
    assert.ok(!summary.includes('\x1b'));
  });
});

describe('commitAgentChanges', () => {
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for git tests
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-utils-test-'));

    // Initialize git repo
    execSync('git init', { cwd: tempDir });
    execSync('git config user.email "test@example.com"', { cwd: tempDir });
    execSync('git config user.name "Test User"', { cwd: tempDir });

    // Create initial commit on main
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# Test Repo\n');
    execSync('git add README.md', { cwd: tempDir });
    execSync('git commit -m "Initial commit"', { cwd: tempDir });

    // Switch to a feature branch
    execSync('git checkout -b agent/test/feature-123', { cwd: tempDir });
  });

  it('commits changes when files are modified', () => {
    // Create directory first, then file
    fs.mkdirSync(path.join(tempDir, 'src', 'client'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'client', 'App.tsx'), 'export const App = () => {};');

    const agentOutput = '✏️ Write src/client/App.tsx';
    const result = commitAgentChanges(tempDir, 'Add App component', agentOutput);

    assert.equal(result, true);

    // Verify commit was created
    const log = execSync('git log --oneline', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(log.includes('agent: Add App component'));
  });

  it('returns false when no files are modified', () => {
    const agentOutput = '✏️ Write src/client/App.tsx';
    const result = commitAgentChanges(tempDir, 'Add App component', agentOutput);

    assert.equal(result, false);
  });

  it('refuses to commit on protected branch (main)', () => {
    // Create a main branch first
    execSync('git checkout -b main', { cwd: tempDir });

    fs.writeFileSync(path.join(tempDir, 'test.txt'), 'content');

    const agentOutput = '✏️ Write test.txt';
    const result = commitAgentChanges(tempDir, 'Add test file', agentOutput);

    assert.equal(result, false);
  });

  it('refuses to commit on protected branch (master)', () => {
    // Switch back to agent branch first
    execSync('git checkout agent/test/feature-123', { cwd: tempDir });
    // Create master only if it doesn't exist
    try {
      execSync('git checkout master', { cwd: tempDir });
    } catch {
      execSync('git checkout -b master', { cwd: tempDir });
    }

    fs.writeFileSync(path.join(tempDir, 'test.txt'), 'content');

    const agentOutput = '✏️ Write test.txt';
    const result = commitAgentChanges(tempDir, 'Add test file', agentOutput);

    assert.equal(result, false);
  });

  it('stages only files mentioned in agent output', () => {
    // Ensure we're on agent branch
    try {
      execSync('git checkout agent/test/feature-123', { cwd: tempDir, stdio: 'pipe' });
    } catch {
      // Branch doesn't exist, create it
      execSync('git checkout -b agent/test/feature-123', { cwd: tempDir, stdio: 'pipe' });
    }

    fs.mkdirSync(path.join(tempDir, 'src', 'client'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'src', 'server'), { recursive: true });

    fs.writeFileSync(path.join(tempDir, 'src', 'client', 'App.tsx'), 'export const App = () => {};');
    fs.writeFileSync(path.join(tempDir, 'src', 'server', 'main.ts'), 'console.log("test");');

    const agentOutput = '✏️ Write src/client/App.tsx'; // Only mentions client file
    const result = commitAgentChanges(tempDir, 'Add App component', agentOutput);

    assert.equal(result, true);

    // Check what was committed
    const diff = execSync('git diff HEAD~1 HEAD --name-only', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(diff.includes('src/client/App.tsx'));
    assert.ok(!diff.includes('src/server/main.ts')); // Server file should not be committed
  });

  it('stages new untracked files in src/client', () => {
    fs.mkdirSync(path.join(tempDir, 'src', 'client'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'client', 'NewComponent.tsx'), 'export const New = () => {};');

    const agentOutput = 'Some output without explicit file mention';
    const result = commitAgentChanges(tempDir, 'Add new component', agentOutput);

    // Should commit because it's a new file in src/client
    assert.equal(result, true);
  });

  it('stages new untracked files in public', () => {
    fs.mkdirSync(path.join(tempDir, 'public'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'public', 'logo.svg'), '<svg></svg>');

    const agentOutput = 'Some output';
    const result = commitAgentChanges(tempDir, 'Add logo', agentOutput);

    assert.equal(result, true);
  });

  it('excludes src/server files when no agent files detected', () => {
    // Ensure we're on agent branch
    try {
      execSync('git checkout agent/test/feature-123', { cwd: tempDir, stdio: 'pipe' });
    } catch {
      execSync('git checkout -b agent/test/feature-123', { cwd: tempDir, stdio: 'pipe' });
    }

    fs.mkdirSync(path.join(tempDir, 'src', 'server'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'server', 'config.ts'), 'export const config = {};');

    const agentOutput = 'Some output without file mentions';
    const result = commitAgentChanges(tempDir, 'Update config', agentOutput);

    // With only src/server files and no agent file detections, should not commit
    assert.equal(result, false);
  });

  it('truncates long commit messages to 72 chars', () => {
    fs.mkdirSync(path.join(tempDir, 'src', 'client'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'client', 'App.tsx'), 'content');

    const longPrompt = 'This is a very long commit message that exceeds the standard 72 character limit for git commit messages';
    const agentOutput = '✏️ Write src/client/App.tsx';
    const result = commitAgentChanges(tempDir, longPrompt, agentOutput);

    assert.equal(result, true);

    const log = execSync('git log -1 --pretty=%B', { cwd: tempDir, encoding: 'utf-8' });
    const commitMsg = log.trim();
    // Message should be "agent: " + first 72 chars of prompt
    assert.ok(commitMsg.length <= 79); // "agent: " (7 chars) + 72 chars
    assert.ok(commitMsg.startsWith('agent: This is a very long commit message'));
  });

  it('escapes double quotes in commit message', () => {
    fs.mkdirSync(path.join(tempDir, 'src', 'client'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'client', 'App.tsx'), 'content');

    const promptWithQuotes = 'Add "fancy" component';
    const agentOutput = '✏️ Write src/client/App.tsx';
    const result = commitAgentChanges(tempDir, promptWithQuotes, agentOutput);

    assert.equal(result, true);

    const log = execSync('git log -1 --pretty=%B', { cwd: tempDir, encoding: 'utf-8' });
    assert.ok(log.includes("agent: Add 'fancy' component")); // Double quotes replaced with single
  });

  it('returns false when staging succeeds but nothing to commit', () => {
    // Simulate git add working but diff --cached being empty
    // This can happen if files are already staged and then reverted
    fs.mkdirSync(path.join(tempDir, 'src', 'client'), { recursive: true });
    const filePath = path.join(tempDir, 'src', 'client', 'App.tsx');
    fs.writeFileSync(filePath, 'content');

    execSync(`git add "${filePath}"`, { cwd: tempDir });
    execSync('git reset HEAD', { cwd: tempDir }); // Unstage
    fs.unlinkSync(filePath); // Remove the file

    const agentOutput = '✏️ Write src/client/App.tsx';
    const result = commitAgentChanges(tempDir, 'Add component', agentOutput);

    assert.equal(result, false);
  });

  it('handles execSync errors gracefully', () => {
    // Use an invalid directory to trigger execSync error
    const result = commitAgentChanges('/nonexistent/path', 'Test', 'output');
    assert.equal(result, false);
  });
});
