import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import type { TextSearchProvider, TextSearchResult } from './types.js';

const execFile = promisify(execFileCb);

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
