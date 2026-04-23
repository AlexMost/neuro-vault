import { execFile as execFileCb } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { TextSearchProvider, TextSearchResult } from './types.js';

const execFile = promisify(execFileCb);

export class GrepSearchProvider implements TextSearchProvider {
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async search(query: string, vaultPath: string, limit: number): Promise<TextSearchResult[]> {
    let stdout: string;

    try {
      const result = await execFile(
        'grep',
        ['-rn', '--include=*.md', `-m`, String(limit), '--', query, vaultPath],
        {
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        },
      );
      stdout = result.stdout;
    } catch (err: unknown) {
      // grep exits with code 1 when there are no matches — that's not an error
      const execError = err as { code?: unknown; stdout?: string };
      if (execError.code === 1 || execError.code === '1') {
        return [];
      }
      throw err;
    }

    const results: TextSearchResult[] = [];

    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      // Format: /absolute/path/file.md:lineNumber:matchLine
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const afterPath = line.indexOf(':', colonIdx + 1);
      if (afterPath === -1) continue;

      const absPath = line.slice(0, colonIdx);
      const lineNumberStr = line.slice(colonIdx + 1, afterPath);
      const matchLine = line.slice(afterPath + 1);

      const lineNumber = parseInt(lineNumberStr, 10);
      if (isNaN(lineNumber)) continue;

      const relativePath = path.relative(vaultPath, absPath);

      results.push({ path: relativePath, matchLine, lineNumber });
    }

    return results;
  }
}

export class ObsidianCliSearchProvider implements TextSearchProvider {
  async isAvailable(): Promise<boolean> {
    try {
      await execFile('obsidian-cli', ['--version'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async search(query: string, vaultPath: string, limit: number): Promise<TextSearchResult[]> {
    try {
      const { stdout } = await execFile(
        'obsidian-cli',
        ['search', '--vault', vaultPath, '--query', query, '--limit', String(limit)],
        { timeout: 15_000 },
      );

      const results: TextSearchResult[] = [];

      for (const rawLine of stdout.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;

        // Best-effort parsing: try colon-separated path:lineNumber:matchLine format
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) {
          // Fallback: treat as just a path with no line info
          results.push({ path: line, matchLine: '', lineNumber: 0 });
          continue;
        }

        const afterPath = line.indexOf(':', colonIdx + 1);
        if (afterPath === -1) {
          results.push({
            path: line.slice(0, colonIdx),
            matchLine: line.slice(colonIdx + 1),
            lineNumber: 0,
          });
          continue;
        }

        const filePath = line.slice(0, colonIdx);
        const lineNumberStr = line.slice(colonIdx + 1, afterPath);
        const matchLine = line.slice(afterPath + 1);
        const lineNumber = parseInt(lineNumberStr, 10);

        results.push({ path: filePath, matchLine, lineNumber: isNaN(lineNumber) ? 0 : lineNumber });
      }

      return results;
    } catch {
      // Graceful degradation: any error returns empty results
      return [];
    }
  }
}
