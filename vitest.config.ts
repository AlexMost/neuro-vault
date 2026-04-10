import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

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
    passWithNoTests: !hasAnyTests,
  },
});
