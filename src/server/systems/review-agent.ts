/**
 * Review agent system — spawns and manages code review agents for merge gates.
 *
 * Guidelines are individual, approvable entries per repo. The flow:
 * 1. scanRepoForGuidelines() discovers MD files and creates 'proposed' guidelines
 * 2. User reviews and approves/rejects each guideline (or approves all)
 * 3. User can add custom guidelines or assign a folder of MD files
 * 4. buildReviewPrompt() only includes 'approved' guidelines
 *
 * This gives the user full visibility and control over what the review agent knows.
 */
import fs from 'fs';
import path from 'path';
import {
  getReviewConfig, upsertReviewConfig, generateId, getAll, getOne,
  insertReviewFinding, createGuideline, listApprovedGuidelines, guidelineExistsForPath,
  listGuidelines,
} from '../db-helpers.js';
import type { ReviewConfig, ReviewFinding, ReviewGuideline } from '../../client/lib/types.js';
import { minimatch } from 'minimatch';

// ── Known File Patterns ──

/** Exact files to auto-discover (checked first, high confidence) */
const KNOWN_FILES: Array<{ path: string; type: ReviewGuideline['type']; description: string }> = [
  { path: 'ARCHITECTURE.md', type: 'architecture', description: 'Project architecture documentation' },
  { path: 'CLAUDE.md', type: 'convention', description: 'Claude Code project instructions' },
  { path: 'CONTRIBUTING.md', type: 'convention', description: 'Contribution guidelines' },
  { path: 'SECURITY.md', type: 'security', description: 'Security policy' },
  { path: 'aider-conventions.md', type: 'convention', description: 'Aider conventions' },
  { path: '.cursorrules', type: 'convention', description: 'Cursor rules' },
  { path: '.clinerules', type: 'convention', description: 'Cline rules' },
  { path: '.coderabbit.yaml', type: 'convention', description: 'CodeRabbit review config' },
  { path: '.github/CODEOWNERS', type: 'convention', description: 'Code ownership rules' },
];

/** Directories to recursively scan for docs */
const DOC_DIRS = ['docs', 'doc', 'documentation', '.github'];

/** Extensions treated as documentation/config */
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt']);
const CONFIG_EXTENSIONS = new Set(['.yaml', '.yml']);

/** Directories that typically hold data patterns (characters, configs, fixtures) */
const DATA_DIR_HINTS = ['characters', 'config', 'configs', 'data', 'fixtures', 'templates', 'schemas', 'admin_config', 'admin_config_yaml'];

/** Max file size for auto-discovered content (200KB) */
const MAX_CONTENT_SIZE = 200 * 1024;

/** Max files to discover in a single scan (prevent runaway on huge repos) */
const MAX_DISCOVERED_FILES = 50;

const TEST_FRAMEWORKS: Array<{ file: string; command: string }> = [
  { file: 'vitest.config.ts', command: 'npx vitest run' },
  { file: 'vitest.config.js', command: 'npx vitest run' },
  { file: 'jest.config.ts', command: 'npx jest' },
  { file: 'jest.config.js', command: 'npx jest' },
  { file: 'playwright.config.ts', command: 'npx playwright test' },
  { file: 'pytest.ini', command: 'pytest' },
  { file: 'setup.py', command: 'python -m pytest' },
  { file: 'Cargo.toml', command: 'cargo test' },
  { file: 'go.mod', command: 'go test ./...' },
];

// ── Guideline Discovery ──

/**
 * Scan a repo for potential review guidelines.
 * Creates 'proposed' guidelines for each discovered file.
 * Returns the newly proposed guidelines (skips files already tracked).
 *
 * Discovery layers:
 * 1. Known files (CLAUDE.md, ARCHITECTURE.md, etc.)
 * 2. Recursive doc directory scan (docs/, doc/, .github/)
 * 3. Config/data directories (YAML configs, JSON patterns)
 * 4. Root-level config files
 */
export function scanRepoForGuidelines(
  repoPath: string,
  broadcast: (g: ReviewGuideline) => void,
): { proposed: ReviewGuideline[]; existingCount: number } {
  const proposed: ReviewGuideline[] = [];
  let existingCount = 0;
  let totalDiscovered = 0;

  const trackResult = (relPath: string, result: 'created' | 'exists' | 'error') => {
    if (result === 'created') {
      const g = listGuidelines(repoPath).find(g => g.source_path === relPath);
      if (g) proposed.push(g);
      totalDiscovered++;
    } else if (result === 'exists') {
      existingCount++;
    }
  };

  // ── Layer 1: Known files ──
  for (const known of KNOWN_FILES) {
    if (totalDiscovered >= MAX_DISCOVERED_FILES) break;
    const fullPath = path.join(repoPath, known.path);
    if (fs.existsSync(fullPath)) {
      trackResult(known.path, createGuidelineFromFile(repoPath, known.path, known.type, known.description, broadcast));
    }
  }

  // ── Layer 2: Recursive doc directory scan ──
  for (const docDir of DOC_DIRS) {
    if (totalDiscovered >= MAX_DISCOVERED_FILES) break;
    const dirPath = path.join(repoPath, docDir);
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) continue;

    const docFiles = walkDir(dirPath, repoPath, (ext) => DOC_EXTENSIONS.has(ext));
    for (const relPath of docFiles) {
      if (totalDiscovered >= MAX_DISCOVERED_FILES) break;
      // Infer type from path
      const type = inferTypeFromPath(relPath);
      const description = `Documentation (${path.dirname(relPath)})`;
      trackResult(relPath, createGuidelineFromFile(repoPath, relPath, type, description, broadcast));
    }
  }

  // ── Layer 3: Config/data directories ──
  // Look for directories that hold YAML configs or JSON data patterns
  // These are critical for repos like glaze_bot where the system behavior
  // is defined in config files and character definitions
  const topLevelEntries = safeReadDir(repoPath);
  for (const entry of topLevelEntries) {
    if (totalDiscovered >= MAX_DISCOVERED_FILES) break;
    const entryLower = entry.toLowerCase();

    // Check if this looks like a data/config directory
    const isDataDir = DATA_DIR_HINTS.some(hint => entryLower === hint || entryLower.includes('config'));
    if (!isDataDir) continue;

    const dirPath = path.join(repoPath, entry);
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) continue;

    // Scan for YAML config files
    const configFiles = walkDir(dirPath, repoPath, (ext) => CONFIG_EXTENSIONS.has(ext));
    for (const relPath of configFiles) {
      if (totalDiscovered >= MAX_DISCOVERED_FILES) break;
      trackResult(relPath, createGuidelineFromFile(repoPath, relPath, 'architecture', `Configuration (${path.dirname(relPath)})`, broadcast));
    }

    // Scan for JSON data patterns — but only create ONE summary guideline per dir,
    // not one per JSON file. We read the first file as an example of the pattern.
    const jsonFiles = walkDir(dirPath, repoPath, (ext) => ext === '.json');
    if (jsonFiles.length > 0) {
      if (totalDiscovered >= MAX_DISCOVERED_FILES) break;
      const relDir = path.relative(repoPath, dirPath).replace(/\\/g, '/');
      const summaryPath = `${relDir}/*.json`;

      if (!guidelineExistsForPath(repoPath, summaryPath)) {
        // Read the first JSON file as an example pattern
        const examplePath = path.join(repoPath, jsonFiles[0]);
        try {
          const exampleContent = fs.readFileSync(examplePath, 'utf-8');
          const parsed = JSON.parse(exampleContent);
          const keys = Object.keys(parsed);

          // Build a pattern summary showing the shape and listing all files
          let content = `## Data Pattern: ${relDir}/\n\n`;
          content += `**${jsonFiles.length} files** in this directory define data entities.\n\n`;
          content += `### Schema (from \`${jsonFiles[0]}\`)\n`;
          content += `Fields: ${keys.map(k => `\`${k}\``).join(', ')}\n\n`;
          content += '```json\n' + JSON.stringify(parsed, null, 2).slice(0, 2000) + '\n```\n\n';
          content += `### All files\n`;
          content += jsonFiles.map(f => `- \`${f}\``).join('\n') + '\n\n';
          content += `### Review Rules\n`;
          content += `- New entries in this directory MUST follow the schema above\n`;
          content += `- All required fields (${keys.map(k => `\`${k}\``).join(', ')}) must be present\n`;
          content += `- Values should be consistent with existing entries\n`;

          createGuideline({
            repoPath,
            name: `${formatGuidelineName(entry)} Data Pattern`,
            description: `Schema and consistency rules for ${jsonFiles.length} ${entry} files`,
            type: 'architecture',
            source: 'discovered',
            sourcePath: summaryPath,
            content,
            scope: `${relDir}/**`,
          }, broadcast);

          const g = listGuidelines(repoPath).find(g => g.source_path === summaryPath);
          if (g) proposed.push(g);
          totalDiscovered++;
        } catch { /* skip unparseable JSON */ }
      } else {
        existingCount++;
      }
    }
  }

  // ── Layer 4: Root-level config files (not in subdirs) ──
  for (const entry of topLevelEntries) {
    if (totalDiscovered >= MAX_DISCOVERED_FILES) break;
    const ext = path.extname(entry).toLowerCase();
    const fullPath = path.join(repoPath, entry);

    // Root-level YAML/YML files that aren't already known
    if (CONFIG_EXTENSIONS.has(ext) && fs.statSync(fullPath).isFile()) {
      // Skip common non-guideline YAML files
      if (['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'docker-compose.yaml', 'docker-compose.yml'].includes(entry)) continue;
      trackResult(entry, createGuidelineFromFile(repoPath, entry, 'convention', 'Root configuration', broadcast));
    }
  }

  // Ensure review_config exists (for test command, target branch, etc.)
  ensureReviewConfig(repoPath);

  console.log(`[review-agent] Scanned ${repoPath}: ${proposed.length} new guidelines proposed, ${existingCount} already tracked`);
  return { proposed: proposed.filter(Boolean), existingCount };
}

/**
 * Recursively walk a directory, returning relative paths matching the extension filter.
 * Skips node_modules, .git, dist, build, and other non-source directories.
 */
function walkDir(dir: string, repoRoot: string, extFilter: (ext: string) => boolean, maxDepth = 3): string[] {
  const results: string[] = [];
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.svelte-kit', '.next', '__pycache__', '.turbo', 'target']);

  function walk(current: string, depth: number) {
    if (depth > maxDepth) return;
    const entries = safeReadDir(current);
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const fullPath = path.join(current, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (stat.isFile() && stat.size <= MAX_CONTENT_SIZE) {
          const ext = path.extname(entry).toLowerCase();
          if (extFilter(ext)) {
            results.push(path.relative(repoRoot, fullPath).replace(/\\/g, '/'));
          }
        }
      } catch { /* skip inaccessible */ }
    }
  }

  walk(dir, 0);
  return results;
}

/** Safe readdir that returns empty array on error */
function safeReadDir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** Infer guideline type from file path */
function inferTypeFromPath(relPath: string): ReviewGuideline['type'] {
  const lower = relPath.toLowerCase();
  if (lower.includes('security') || lower.includes('auth')) return 'security';
  if (lower.includes('test') || lower.includes('e2e') || lower.includes('spec')) return 'test';
  if (lower.includes('convention') || lower.includes('style') || lower.includes('lint') || lower.includes('contributing')) return 'convention';
  return 'architecture';
}

/**
 * Create a guideline from a file on disk.
 * Returns 'created', 'exists', or 'error'.
 */
function createGuidelineFromFile(
  repoPath: string,
  relPath: string,
  type: ReviewGuideline['type'],
  description: string,
  broadcast: (g: ReviewGuideline) => void,
): 'created' | 'exists' | 'error' {
  if (guidelineExistsForPath(repoPath, relPath)) {
    return 'exists';
  }

  const fullPath = path.join(repoPath, relPath);
  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    if (!content.trim()) return 'error'; // skip empty files

    const name = path.basename(relPath, path.extname(relPath));
    createGuideline({
      repoPath,
      name: formatGuidelineName(name),
      description,
      type,
      source: 'discovered',
      sourcePath: relPath,
      content,
      scope: inferScope(relPath, content),
    }, broadcast);

    return 'created';
  } catch {
    return 'error';
  }
}

/**
 * Scan a folder of MD files and create guidelines from each one.
 * All files in the folder become proposed guidelines.
 */
export function scanFolderForGuidelines(
  repoPath: string,
  folderPath: string,
  type: ReviewGuideline['type'] = 'custom',
  broadcast: (g: ReviewGuideline) => void,
): ReviewGuideline[] {
  const created: ReviewGuideline[] = [];

  // Resolve folder path — could be absolute or relative to repo
  const resolvedFolder = path.isAbsolute(folderPath)
    ? folderPath
    : path.join(repoPath, folderPath);

  if (!fs.existsSync(resolvedFolder) || !fs.statSync(resolvedFolder).isDirectory()) {
    console.error(`[review-agent] Folder not found or not a directory: ${resolvedFolder}`);
    return [];
  }

  const files = fs.readdirSync(resolvedFolder);
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!['.md', '.mdx', '.txt', '.yaml', '.yml'].includes(ext)) continue;

    const fullPath = path.join(resolvedFolder, file);
    if (!fs.statSync(fullPath).isFile()) continue;

    // Compute relative path from repo root if inside repo, otherwise use absolute
    let relPath: string;
    if (fullPath.startsWith(repoPath)) {
      relPath = path.relative(repoPath, fullPath).replace(/\\/g, '/');
    } else {
      relPath = fullPath.replace(/\\/g, '/');
    }

    if (guidelineExistsForPath(repoPath, relPath)) continue;

    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (!content.trim()) continue;

      const name = path.basename(file, path.extname(file));
      const g = createGuideline({
        repoPath,
        name: formatGuidelineName(name),
        description: `From folder: ${folderPath}`,
        type,
        source: 'folder',
        sourcePath: relPath,
        content,
        scope: inferScope(relPath, content),
      }, broadcast);

      if (g) created.push(g);
    } catch { /* skip unreadable files */ }
  }

  console.log(`[review-agent] Scanned folder ${folderPath}: ${created.length} guidelines created`);
  return created;
}

// ── Deep Scan: Architecture Analysis ──

/** File extensions that are likely to contain type definitions and interfaces */
const TYPE_EXTENSIONS = new Set(['.ts', '.tsx', '.d.ts']);

/** File names that are high-signal for understanding a system */
const HIGH_SIGNAL_NAMES = new Set([
  'types.ts', 'types.tsx', 'constants.ts', 'config.ts', 'schema.ts',
  'index.ts', 'engine.ts', 'pipeline.ts', 'events.ts', 'models.ts',
  'interfaces.ts', 'enums.ts', 'state.ts', 'machine.ts',
  // Python
  'models.py', 'schema.py', 'types.py', 'config.py', '__init__.py',
  // Rust
  'lib.rs', 'mod.rs', 'types.rs', 'config.rs',
  // Go
  'types.go', 'models.go', 'config.go',
]);

/**
 * Deep-scan a repo to build a source map for architecture analysis.
 * This reads key source files (types, configs, entry points) and
 * produces a structured summary that can be used to generate guidelines.
 *
 * Returns a prompt that can be sent to an LLM to synthesize guidelines,
 * plus the raw source map for reference.
 */
export function buildDeepScanPrompt(repoPath: string): { prompt: string; sourceMap: SourceMapEntry[] } {
  const sourceMap = buildSourceMap(repoPath);

  if (sourceMap.length === 0) {
    return { prompt: '', sourceMap: [] };
  }

  let prompt = `You are analyzing a codebase to generate review guidelines for a QA code review agent.

## Repository: ${path.basename(repoPath)}

Below is a source map of the key files in this repository. Based on these files, generate a set of review guidelines that a QA agent should follow when reviewing code changes.

## Source Map

`;

  for (const entry of sourceMap) {
    prompt += `### ${entry.relPath}\n`;
    prompt += `*${entry.description}*\n`;
    if (entry.content.length > 4000) {
      prompt += '```\n' + entry.content.slice(0, 4000) + '\n... (truncated)\n```\n\n';
    } else {
      prompt += '```\n' + entry.content + '\n```\n\n';
    }
  }

  prompt += `## Instructions

Based on the source map above, generate review guidelines. Each guideline should help a QA agent understand how this codebase works and what to look for during code review.

Output each guideline in this exact format (output 3-8 guidelines):

GUIDELINE_START
NAME: <short descriptive name>
TYPE: architecture|convention|test|security
SCOPE: <glob pattern for which files this applies to, or * for all>
DESCRIPTION: <one-line description>
CONTENT:
<detailed markdown content explaining:
- How this part of the system works
- What patterns must be followed
- What to check during review
- Common mistakes to watch for>
GUIDELINE_END

Focus on:
1. Core system patterns (how entities are defined, how the engine works)
2. Data format consistency (schemas, configs, JSON patterns)
3. Architecture rules (module boundaries, import patterns, state management)
4. Convention enforcement (naming, file organization, error handling)
5. Integration points (how components connect, event flows)
`;

  return { prompt, sourceMap };
}

export interface SourceMapEntry {
  relPath: string;
  description: string;
  content: string;
  size: number;
}

/**
 * Build a source map of key files in a repo.
 * Finds type definitions, configs, entry points, and high-signal files.
 */
function buildSourceMap(repoPath: string): SourceMapEntry[] {
  const entries: SourceMapEntry[] = [];
  const maxEntries = 30;
  const maxFileSize = 50 * 1024; // 50KB per file
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.svelte-kit', '.next', '__pycache__', '.turbo', 'target', '.tauri', '.wrangler']);

  // Find key source directories (look for src/, lib/, app/, packages/, etc.)
  const sourceDirSet = new Set<string>();
  const topEntries = safeReadDir(repoPath);
  for (const entry of topEntries) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = path.join(repoPath, entry);
    try {
      if (!fs.statSync(fullPath).isDirectory()) continue;
    } catch { continue; }

    // Direct source dirs
    if (['src', 'lib', 'app'].includes(entry)) {
      sourceDirSet.add(fullPath);
    }
    // Monorepo: apps/*/src, packages/*/src
    if (['apps', 'packages', 'modules', 'services'].includes(entry)) {
      const subEntries = safeReadDir(fullPath);
      for (const sub of subEntries) {
        const subPath = path.join(fullPath, sub);
        try {
          if (!fs.statSync(subPath).isDirectory()) continue;
        } catch { continue; }
        // Add src/lib dir if it exists (prefer specific over parent)
        let foundSrc = false;
        for (const srcDir of ['src', 'lib']) {
          const srcPath = path.join(subPath, srcDir);
          if (fs.existsSync(srcPath)) { sourceDirSet.add(srcPath); foundSrc = true; }
        }
        // If no src/lib, add the package dir itself
        if (!foundSrc) sourceDirSet.add(subPath);
      }
    }
  }
  const sourceDirs = [...sourceDirSet];

  // Walk each source dir looking for high-signal files (dedup by relPath)
  const seenPaths = new Set<string>();
  for (const dir of sourceDirs) {
    if (entries.length >= maxEntries) break;
    findHighSignalFiles(dir, repoPath, entries, maxEntries, maxFileSize, SKIP_DIRS, 4, 0, seenPaths);
  }

  // Also look for root-level high-signal files (package.json, tsconfig, etc.)
  for (const entry of topEntries) {
    if (entries.length >= maxEntries) break;
    if (entry === 'package.json' || entry === 'turbo.json' || entry === 'tsconfig.base.json') {
      const fullPath = path.join(repoPath, entry);
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (content.length <= maxFileSize) {
          entries.push({
            relPath: entry,
            description: 'Project configuration',
            content,
            size: content.length,
          });
        }
      } catch { /* skip */ }
    }
  }

  return entries;
}

function findHighSignalFiles(
  dir: string,
  repoRoot: string,
  entries: SourceMapEntry[],
  maxEntries: number,
  maxFileSize: number,
  skipDirs: Set<string>,
  maxDepth: number,
  depth = 0,
  seenPaths = new Set<string>(),
): void {
  if (depth > maxDepth || entries.length >= maxEntries) return;

  const dirEntries = safeReadDir(dir);
  for (const entry of dirEntries) {
    if (entries.length >= maxEntries) return;
    if (skipDirs.has(entry)) continue;

    const fullPath = path.join(dir, entry);
    try {
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        findHighSignalFiles(fullPath, repoRoot, entries, maxEntries, maxFileSize, skipDirs, maxDepth, depth + 1, seenPaths);
      } else if (stat.isFile() && stat.size <= maxFileSize) {
        const ext = path.extname(entry).toLowerCase();
        const isHighSignal = HIGH_SIGNAL_NAMES.has(entry)
          || (TYPE_EXTENSIONS.has(ext) && (entry.includes('type') || entry.includes('interface') || entry.includes('schema') || entry.includes('constant')));

        if (isHighSignal) {
          const relPath = path.relative(repoRoot, fullPath).replace(/\\/g, '/');
          if (seenPaths.has(relPath)) continue;
          seenPaths.add(relPath);
          const content = fs.readFileSync(fullPath, 'utf-8');
          entries.push({
            relPath,
            description: describeSourceFile(entry, relPath),
            content,
            size: content.length,
          });
        }
      }
    } catch { /* skip inaccessible */ }
  }
}

function describeSourceFile(fileName: string, relPath: string): string {
  const name = fileName.toLowerCase();
  if (name.includes('type')) return 'Type definitions';
  if (name.includes('interface')) return 'Interface definitions';
  if (name.includes('constant') || name.includes('enum')) return 'Constants and enumerations';
  if (name.includes('config')) return 'Configuration';
  if (name.includes('schema')) return 'Schema definitions';
  if (name.includes('engine')) return 'Core engine logic';
  if (name.includes('pipeline')) return 'Processing pipeline';
  if (name.includes('event')) return 'Event system';
  if (name.includes('state') || name.includes('machine')) return 'State management';
  if (name.includes('model')) return 'Data models';
  if (name === 'index.ts' || name === 'index.tsx') return `Module entry point (${path.dirname(relPath)})`;
  if (name === 'lib.rs') return 'Rust library entry point';
  return 'Source file';
}

/**
 * Parse deep-scan LLM output into individual guidelines.
 * Returns guidelines ready to be created in the database.
 */
export function parseDeepScanOutput(output: string): Array<{
  name: string;
  type: ReviewGuideline['type'];
  scope: string;
  description: string;
  content: string;
}> {
  const guidelines: Array<{ name: string; type: ReviewGuideline['type']; scope: string; description: string; content: string }> = [];

  const blocks = output.split('GUIDELINE_START').slice(1);
  for (const block of blocks) {
    const endIdx = block.indexOf('GUIDELINE_END');
    const content = endIdx >= 0 ? block.slice(0, endIdx) : block;

    const nameMatch = content.match(/^NAME:\s*(.+)/m);
    const typeMatch = content.match(/^TYPE:\s*(\S+)/m);
    const scopeMatch = content.match(/^SCOPE:\s*(.+)/m);
    const descMatch = content.match(/^DESCRIPTION:\s*(.+)/m);
    const contentMatch = content.match(/^CONTENT:\s*\n([\s\S]+)/m);

    if (nameMatch && contentMatch) {
      const rawType = (typeMatch?.[1] || 'architecture').trim().toLowerCase();
      const validTypes = new Set(['architecture', 'convention', 'test', 'security', 'custom']);
      const type = (validTypes.has(rawType) ? rawType : 'architecture') as ReviewGuideline['type'];

      guidelines.push({
        name: nameMatch[1].trim(),
        type,
        scope: scopeMatch?.[1]?.trim() || '*',
        description: descMatch?.[1]?.trim() || '',
        content: contentMatch[1].trim(),
      });
    }
  }

  return guidelines;
}

/**
 * Store deep-scan results as proposed guidelines.
 */
export function storeDeepScanGuidelines(
  repoPath: string,
  parsedGuidelines: ReturnType<typeof parseDeepScanOutput>,
  broadcast: (g: ReviewGuideline) => void,
): ReviewGuideline[] {
  const created: ReviewGuideline[] = [];

  for (const g of parsedGuidelines) {
    const sourcePath = `deep-scan/${g.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    if (guidelineExistsForPath(repoPath, sourcePath)) continue;

    const result = createGuideline({
      repoPath,
      name: g.name,
      description: g.description,
      type: g.type,
      source: 'discovered',
      sourcePath,
      content: g.content,
      scope: g.scope,
      status: 'proposed',
    }, broadcast);

    if (result) created.push(result);
  }

  return created;
}

// ── Helpers ──

/** Convert a file name to a human-readable guideline name */
function formatGuidelineName(name: string): string {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

/**
 * Infer a scope pattern from the file path and content.
 * e.g., a file in docs/api/ might scope to 'src/api/**'
 */
function inferScope(relPath: string, _content: string): string {
  // Files in specific directories might scope to matching source dirs
  const dir = path.dirname(relPath);
  if (dir === 'docs' || dir === '.') return '*'; // applies to everything

  // If the doc is in a subdirectory like docs/api, scope to src/api/**
  if (dir.startsWith('docs/')) {
    const subdir = dir.replace('docs/', '');
    return `src/${subdir}/**`;
  }

  return '*';
}

/**
 * Ensure a review_config record exists for this repo.
 * Discovers test framework, target branch, etc.
 */
function ensureReviewConfig(repoPath: string): ReviewConfig | null {
  const existing = getReviewConfig(repoPath);
  if (existing) return existing;

  let testCommand = '';
  for (const { file, command } of TEST_FRAMEWORKS) {
    if (fs.existsSync(path.join(repoPath, file))) {
      testCommand = command;
      break;
    }
  }

  if (!testCommand) {
    const pkgPath = path.join(repoPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.scripts?.test) testCommand = 'npm test';
      } catch { /* skip */ }
    }
  }

  return upsertReviewConfig({
    repo_path: repoPath,
    test_command: testCommand,
  });
}

/**
 * Get or discover review config for a repo.
 * Also triggers guideline scan if no guidelines exist yet.
 */
export function getOrDiscoverReviewConfig(repoPath: string): ReviewConfig | null {
  return ensureReviewConfig(repoPath);
}

// ── Review Prompt Building ──

/**
 * Filter guidelines by scope — only include guidelines whose scope pattern
 * matches at least one of the changed files.
 */
function filterGuidelinesByScope(guidelines: ReviewGuideline[], filesChanged: string[]): ReviewGuideline[] {
  return guidelines.filter(g => {
    if (g.scope === '*') return true;
    return filesChanged.some(f => minimatch(f, g.scope));
  });
}

/**
 * Build the review prompt for a review agent.
 * Pulls from approved guidelines instead of review_config blobs.
 */
export function buildReviewPrompt(params: {
  goalName: string;
  goalDescription: string;
  targetBranch: string;
  filesChanged: string[];
  consolidatedDiff: string;
  config: ReviewConfig;
  tasks: Array<{ title: string; description: string }>;
  repoPath: string;
}): string {
  const { goalName, goalDescription, targetBranch, filesChanged, consolidatedDiff, config, tasks, repoPath } = params;

  // Get approved guidelines, filtered by scope
  const allGuidelines = listApprovedGuidelines(repoPath);
  const relevantGuidelines = filterGuidelinesByScope(allGuidelines, filesChanged);

  // Group by type for structured prompt
  const byType: Record<string, ReviewGuideline[]> = {};
  for (const g of relevantGuidelines) {
    (byType[g.type] ??= []).push(g);
  }

  let prompt = `You are reviewing a consolidated set of changes for goal: "${goalName}"
Description: ${goalDescription}
Target branch: ${targetBranch}
Files changed (${filesChanged.length}):
${filesChanged.map(f => `  - ${f}`).join('\n')}

Tasks completed:
${tasks.map((t, i) => `  ${i + 1}. ${t.title}: ${t.description}`).join('\n')}
`;

  // Add guidelines by type
  const typeLabels: Record<string, string> = {
    architecture: 'Architecture & Design',
    convention: 'Conventions & Style',
    custom: 'Project-Specific Guidelines',
    test: 'Testing Requirements',
    security: 'Security Guidelines',
  };

  for (const [type, guidelines] of Object.entries(byType)) {
    const label = typeLabels[type] || type;
    prompt += `\n## ${label}\n`;
    prompt += `*${guidelines.length} guideline(s) active for this review*\n\n`;

    for (const g of guidelines) {
      prompt += `### ${g.name}`;
      if (g.scope !== '*') prompt += ` (scope: \`${g.scope}\`)`;
      prompt += `\n`;
      if (g.description) prompt += `*${g.description}*\n`;
      prompt += `${g.content}\n\n`;
    }
  }

  // Fall back to review_config blobs if no guidelines exist (backwards compat)
  if (relevantGuidelines.length === 0) {
    if (config.architecture_doc) {
      prompt += `\n## Architecture Context\n${config.architecture_doc}\n`;
    }
    if (config.conventions) {
      prompt += `\n## Conventions\n${config.conventions}\n`;
    }
  }

  // Path-specific rules from config (still supported)
  try {
    const rules = JSON.parse(config.rules);
    if (Object.keys(rules).length > 0) {
      prompt += `\n## Path-Specific Review Rules\n`;
      for (const [pattern, rule] of Object.entries(rules)) {
        prompt += `- \`${pattern}\`: ${rule}\n`;
      }
    }
  } catch { /* rules not valid JSON, skip */ }

  prompt += `\n## The Diff\n\`\`\`diff\n${consolidatedDiff}\n\`\`\`\n`;

  prompt += `
Review for:
1. Logic bugs and correctness
2. Security vulnerabilities (OWASP top 10)
3. Architecture violations (check against guidelines above)
4. Missing test coverage
5. Performance concerns
6. Code style / convention violations

For each finding, output one block in this exact format:
FINDING: severity=critical|warning|info|suggestion
FILE: path/to/file
LINES: start-end
CATEGORY: bug|security|performance|style|architecture|test-coverage
DESCRIPTION: what's wrong
SUGGESTION: how to fix

End with:
VERDICT: approve|changes_requested|reject
SCORE: 0-100
SUMMARY: one paragraph overall assessment
`;

  return prompt;
}

// ── Review Output Parsing ──

interface ParsedReviewResult {
  findings: Array<{
    severity: ReviewFinding['severity'];
    filePath: string;
    lineStart: number | null;
    lineEnd: number | null;
    category: ReviewFinding['category'];
    description: string;
    suggestion: string | null;
  }>;
  verdict: 'approve' | 'changes_requested' | 'reject';
  score: number;
  summary: string;
}

const VALID_SEVERITIES = new Set(['critical', 'warning', 'info', 'suggestion']);
const VALID_CATEGORIES = new Set(['bug', 'security', 'performance', 'style', 'architecture', 'test-coverage']);

/**
 * Parse structured review output from the review agent.
 */
export function parseReviewOutput(output: string): ParsedReviewResult {
  const findings: ParsedReviewResult['findings'] = [];
  let verdict: ParsedReviewResult['verdict'] = 'approve';
  let score = 100;
  let summary = '';

  // Parse findings
  const findingBlocks = output.split(/^FINDING:/gm).slice(1);
  for (const block of findingBlocks) {
    const lines = block.trim().split('\n');
    const severityMatch = lines[0]?.match(/severity=(critical|warning|info|suggestion)/);
    const fileMatch = lines.find(l => l.startsWith('FILE:'))?.replace('FILE:', '').trim();
    const linesMatch = lines.find(l => l.startsWith('LINES:'))?.replace('LINES:', '').trim();
    const categoryMatch = lines.find(l => l.startsWith('CATEGORY:'))?.replace('CATEGORY:', '').trim();
    const descMatch = lines.find(l => l.startsWith('DESCRIPTION:'))?.replace('DESCRIPTION:', '').trim();
    const suggMatch = lines.find(l => l.startsWith('SUGGESTION:'))?.replace('SUGGESTION:', '').trim();

    const sev = severityMatch?.[1] || 'info';
    const cat = categoryMatch || 'bug';

    if (fileMatch && descMatch) {
      let lineStart: number | null = null;
      let lineEnd: number | null = null;
      if (linesMatch) {
        const parts = linesMatch.split('-');
        lineStart = parseInt(parts[0], 10) || null;
        lineEnd = parts.length > 1 ? (parseInt(parts[1], 10) || null) : lineStart;
      }

      findings.push({
        severity: (VALID_SEVERITIES.has(sev) ? sev : 'info') as ReviewFinding['severity'],
        filePath: fileMatch,
        lineStart,
        lineEnd,
        category: (VALID_CATEGORIES.has(cat) ? cat : 'bug') as ReviewFinding['category'],
        description: descMatch,
        suggestion: suggMatch || null,
      });
    }
  }

  // Parse verdict
  const verdictMatch = output.match(/^VERDICT:\s*(approve|changes_requested|reject)/m);
  if (verdictMatch) {
    verdict = verdictMatch[1] as ParsedReviewResult['verdict'];
  }

  // Parse score
  const scoreMatch = output.match(/^SCORE:\s*(\d+)/m);
  if (scoreMatch) {
    score = Math.min(100, Math.max(0, parseInt(scoreMatch[1], 10)));
  }

  // Parse summary
  const summaryMatch = output.match(/^SUMMARY:\s*(.+)/m);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  }

  return { findings, verdict, score, summary };
}

/**
 * Store parsed review findings in the database.
 */
export function storeReviewFindings(
  mergeGateId: string,
  reviewCycle: number,
  findings: ParsedReviewResult['findings'],
): void {
  for (const f of findings) {
    insertReviewFinding({
      id: generateId(),
      merge_gate_id: mergeGateId,
      review_cycle: reviewCycle,
      severity: f.severity,
      file_path: f.filePath,
      line_start: f.lineStart,
      line_end: f.lineEnd,
      category: f.category,
      description: f.description,
      suggestion: f.suggestion,
      resolved: 0,
      resolved_by: null,
    });
  }
}

/**
 * Build a revision prompt from unresolved review findings.
 */
export function buildRevisionPrompt(findings: ReviewFinding[]): string {
  if (findings.length === 0) return '';

  let prompt = `The code review found the following issues that need to be fixed:\n\n`;

  for (const f of findings) {
    prompt += `## ${f.severity.toUpperCase()}: ${f.file_path}`;
    if (f.line_start) prompt += `:${f.line_start}`;
    if (f.line_end && f.line_end !== f.line_start) prompt += `-${f.line_end}`;
    prompt += `\n`;
    prompt += `Category: ${f.category}\n`;
    prompt += `Issue: ${f.description}\n`;
    if (f.suggestion) prompt += `Suggested fix: ${f.suggestion}\n`;
    prompt += `\n`;
  }

  prompt += `Fix each issue listed above. Focus on critical and warning severity issues first. Make minimal, targeted changes.`;
  return prompt;
}
