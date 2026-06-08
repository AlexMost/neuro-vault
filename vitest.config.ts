import fs from 'node:fs';
import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

// Worktrees hold full repo checkouts with their own test files. Without this,
// `vitest run` from the root collects every worktree's tests too.
const worktreeGlobs = ['**/.worktrees/**', '**/.claude/worktrees/**'];

function hasTestFiles(rootDir: string): boolean {
  if (!fs.existsSync(rootDir)) {
    return false;
  }

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (hasTestFiles(fullPath)) {
        return true;
      }
      continue;
    }

    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
      return true;
    }
  }

  return false;
}

const hasAnyTests = hasTestFiles('test') || hasTestFiles('src');

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...worktreeGlobs],
    passWithNoTests: !hasAnyTests,
  },
});
