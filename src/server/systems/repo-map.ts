/**
 * Smart repo map — ranked codebase context for planning prompts.
 *
 * Uses the TypeScript Compiler API to extract exports + imports from every
 * .ts/.tsx file, builds an import graph, runs PageRank to rank files by
 * importance, and outputs a condensed map showing the most connected files
 * with their exported symbols (function signatures, interfaces, types).
 *
 * Zero external dependencies — uses typescript (already installed).
 */
import ts from 'typescript';
import fs from 'fs';
import path from 'path';

// ── Types ──

export interface RepoMapEntry {
  filePath: string;
  rank: number;
  exports: ExportedSymbol[];
  importCount: number;
  importedByCount: number;
}

export interface ExportedSymbol {
  name: string;
  kind: 'function' | 'interface' | 'type' | 'class' | 'const' | 'enum';
  signature?: string;
}

export interface RepoMapResult {
  entries: RepoMapEntry[];
  totalFiles: number;
  generatedAt: number;
}

// ── Cache ──

const cache = new Map<string, { result: RepoMapResult; headSha: string }>();

// ── Main ──

/**
 * Build a ranked repo map for a TypeScript/JavaScript project.
 * Results are cached per repo and invalidated when git HEAD changes.
 */
export function buildRepoMap(repoPath: string, maxEntries = 25): RepoMapResult {
  // Check cache
  const headSha = getGitHead(repoPath);
  const cached = cache.get(repoPath);
  if (cached && cached.headSha === headSha) {
    return { ...cached.result, entries: cached.result.entries.slice(0, maxEntries) };
  }

  // Find all TS/JS files
  const files = findSourceFiles(repoPath);
  if (files.length === 0) {
    return { entries: [], totalFiles: 0, generatedAt: Date.now() };
  }

  // Extract exports and imports from each file
  const fileData = new Map<string, { exports: ExportedSymbol[]; imports: string[] }>();
  for (const file of files) {
    const relPath = path.relative(repoPath, file).replace(/\\/g, '/');
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const extracted = extractFromFile(content, file);
      fileData.set(relPath, extracted);
    } catch { /* skip unreadable */ }
  }

  // Build import graph (file → files it imports)
  const importGraph = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();

  for (const [filePath, data] of fileData) {
    const targets = new Set<string>();
    for (const imp of data.imports) {
      const resolved = resolveImport(imp, filePath, fileData);
      if (resolved) targets.add(resolved);
    }
    importGraph.set(filePath, targets);
    for (const target of targets) {
      if (!importedBy.has(target)) importedBy.set(target, new Set());
      importedBy.get(target)!.add(filePath);
    }
  }

  // PageRank
  const ranks = pageRank(importGraph);

  // Build ranked entries
  const entries: RepoMapEntry[] = [];
  for (const [filePath, data] of fileData) {
    if (data.exports.length === 0) continue;
    entries.push({
      filePath,
      rank: ranks.get(filePath) || 0,
      exports: data.exports,
      importCount: importGraph.get(filePath)?.size || 0,
      importedByCount: importedBy.get(filePath)?.size || 0,
    });
  }

  entries.sort((a, b) => b.rank - a.rank);

  const result: RepoMapResult = {
    entries,
    totalFiles: files.length,
    generatedAt: Date.now(),
  };

  // Cache
  cache.set(repoPath, { result, headSha });

  return { ...result, entries: result.entries.slice(0, maxEntries) };
}

/**
 * Format repo map as text for injection into prompts.
 */
export function formatRepoMap(result: RepoMapResult, maxEntries = 20): string {
  if (result.entries.length === 0) return '(no TypeScript files found)';

  const lines: string[] = [];
  lines.push(`## Repo Map (${result.totalFiles} files, top ${Math.min(maxEntries, result.entries.length)} by importance)\n`);

  for (const entry of result.entries.slice(0, maxEntries)) {
    const importedBy = entry.importedByCount > 0 ? ` (imported by ${entry.importedByCount} files)` : '';
    lines.push(`### ${entry.filePath}${importedBy}`);

    for (const exp of entry.exports) {
      if (exp.signature) {
        lines.push(`  ${exp.kind} ${exp.signature}`);
      } else {
        lines.push(`  ${exp.kind} ${exp.name}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Invalidate the cache for a repo (call after agent makes changes).
 */
export function invalidateRepoMapCache(repoPath: string): void {
  cache.delete(repoPath);
}

// ── File Discovery ──

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.svelte-kit', '.next',
  '__pycache__', '.turbo', 'target', '.tauri', '.wrangler', 'coverage',
]);

function findSourceFiles(repoPath: string, maxDepth = 6): string[] {
  const results: string[] = [];
  const maxFiles = 500;

  function walk(dir: string, depth: number) {
    if (depth > maxDepth || results.length >= maxFiles) return;
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }

    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;

      const fullPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (stat.isFile() && stat.size < 200_000) {
          const ext = path.extname(entry).toLowerCase();
          if (ext === '.ts' || ext === '.tsx') {
            // Skip .d.ts, test files, and config files
            if (entry.endsWith('.d.ts')) continue;
            if (entry.includes('.test.') || entry.includes('.spec.')) continue;
            results.push(fullPath);
          }
        }
      } catch { /* skip inaccessible */ }
    }
  }

  walk(repoPath, 0);
  return results;
}

// ── TypeScript Extraction ──

function extractFromFile(content: string, filePath: string): { exports: ExportedSymbol[]; imports: string[] } {
  const sourceFile = ts.createSourceFile(
    path.basename(filePath),
    content,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const exports: ExportedSymbol[] = [];
  const imports: string[] = [];

  function visit(node: ts.Node) {
    // Imports
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }

    // Export declarations: export { x } from './y'
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }

    const isExported = hasExportModifier(node);

    // Functions
    if (ts.isFunctionDeclaration(node) && node.name && isExported) {
      exports.push({
        name: node.name.text,
        kind: 'function',
        signature: getFunctionSignature(node, sourceFile),
      });
    }

    // Interfaces
    if (ts.isInterfaceDeclaration(node) && isExported) {
      const members = node.members
        .filter(m => ts.isPropertySignature(m) && m.name)
        .map(m => (m.name as ts.Identifier).text)
        .slice(0, 8);
      exports.push({
        name: node.name.text,
        kind: 'interface',
        signature: `${node.name.text} { ${members.join(', ')}${node.members.length > 8 ? ', ...' : ''} }`,
      });
    }

    // Type aliases
    if (ts.isTypeAliasDeclaration(node) && isExported) {
      const typeText = node.type.getText(sourceFile).slice(0, 80);
      exports.push({
        name: node.name.text,
        kind: 'type',
        signature: `${node.name.text} = ${typeText}${node.type.getText(sourceFile).length > 80 ? '...' : ''}`,
      });
    }

    // Classes
    if (ts.isClassDeclaration(node) && node.name && isExported) {
      const methods = node.members
        .filter(m => ts.isMethodDeclaration(m) && m.name)
        .map(m => (m.name as ts.Identifier).text)
        .slice(0, 6);
      exports.push({
        name: node.name.text,
        kind: 'class',
        signature: `${node.name.text} { ${methods.join('(), ')}${methods.length ? '()' : ''}${node.members.length > 6 ? ', ...' : ''} }`,
      });
    }

    // Enums
    if (ts.isEnumDeclaration(node) && isExported) {
      const members = node.members.map(m => (m.name as ts.Identifier).text).slice(0, 6);
      exports.push({
        name: node.name.text,
        kind: 'enum',
        signature: `${node.name.text} { ${members.join(', ')}${node.members.length > 6 ? ', ...' : ''} }`,
      });
    }

    // Exported const/let (top-level only)
    if (ts.isVariableStatement(node) && isExported) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          exports.push({
            name: decl.name.text,
            kind: 'const',
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { exports, imports };
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) || false;
}

function getFunctionSignature(node: ts.FunctionDeclaration, sourceFile: ts.SourceFile): string {
  const name = node.name?.text || 'anonymous';
  const params = node.parameters.map(p => {
    const paramName = p.name.getText(sourceFile);
    const paramType = p.type ? p.type.getText(sourceFile) : 'any';
    const optional = p.questionToken ? '?' : '';
    return `${paramName}${optional}: ${paramType}`;
  }).join(', ');
  const returnType = node.type ? node.type.getText(sourceFile) : 'void';
  const isAsync = node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
  return `${isAsync}${name}(${params}): ${returnType}`;
}

// ── Import Resolution ──

function resolveImport(specifier: string, fromFile: string, knownFiles: Map<string, any>): string | null {
  // Only resolve relative imports
  if (!specifier.startsWith('.')) return null;

  const fromDir = path.dirname(fromFile);
  const resolved = path.posix.normalize(path.posix.join(fromDir, specifier));

  // Try with extensions
  const candidates = [
    resolved,
    resolved + '.ts',
    resolved + '.tsx',
    resolved + '/index.ts',
    resolved + '/index.tsx',
  ];

  // Strip .js/.jsx extension (TS uses .js in imports for ESM)
  const stripped = resolved.replace(/\.(js|jsx)$/, '');
  if (stripped !== resolved) {
    candidates.push(stripped + '.ts', stripped + '.tsx');
  }

  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate;
  }

  return null;
}

// ── PageRank ──

function pageRank(graph: Map<string, Set<string>>, damping = 0.85, iterations = 20): Map<string, number> {
  const allNodes = new Set<string>();
  for (const [node, neighbors] of graph) {
    allNodes.add(node);
    for (const n of neighbors) allNodes.add(n);
  }

  const N = allNodes.size;
  if (N === 0) return new Map();

  const rank = new Map<string, number>();
  for (const node of allNodes) rank.set(node, 1 / N);

  for (let i = 0; i < iterations; i++) {
    const newRank = new Map<string, number>();
    for (const node of allNodes) newRank.set(node, (1 - damping) / N);

    for (const [node, neighbors] of graph) {
      if (neighbors.size === 0) continue;
      const share = (rank.get(node) || 0) / neighbors.size;
      for (const neighbor of neighbors) {
        newRank.set(neighbor, (newRank.get(neighbor) || 0) + damping * share);
      }
    }

    for (const [k, v] of newRank) rank.set(k, v);
  }

  return rank;
}

// ── Git HEAD ──

function getGitHead(repoPath: string): string {
  try {
    const headPath = path.join(repoPath, '.git', 'HEAD');
    const head = fs.readFileSync(headPath, 'utf-8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = path.join(repoPath, '.git', head.slice(5));
      return fs.readFileSync(refPath, 'utf-8').trim();
    }
    return head;
  } catch {
    return '';
  }
}
