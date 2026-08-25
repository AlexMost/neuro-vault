import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

export interface GoldenEntry {
  id: string;
  query: string;
  lang: 'ua' | 'en';
  source?: string;
  relevant: string[];
}

/** Any golden-set failure — structural or broken path. The CLI maps it to exit 1. */
export class GoldenSetError extends Error {}

export function goldenSetPath(vaultRoot: string): string {
  return path.join(vaultRoot, '.neuro-vault/eval/golden.yaml');
}

function fail(message: string): never {
  throw new GoldenSetError(message);
}

function asEntry(raw: unknown, index: number): GoldenEntry {
  const label = (id: unknown): string =>
    typeof id === 'string' && id !== '' ? `"${id}"` : `entry ${index + 1}`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`golden set: entry ${index + 1} is not a mapping`);
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || e.id === '') fail(`golden set: ${label(e.id)} is missing id`);
  if (typeof e.query !== 'string' || e.query.trim() === '')
    fail(`golden set: ${label(e.id)} is missing query`);
  if (e.lang !== 'ua' && e.lang !== 'en')
    fail(`golden set: ${label(e.id)} has unknown lang (expected "ua" or "en")`);
  if (
    !Array.isArray(e.relevant) ||
    e.relevant.length === 0 ||
    !e.relevant.every((p): p is string => typeof p === 'string' && p !== '')
  ) {
    fail(`golden set: ${label(e.id)} needs a non-empty relevant list of paths`);
  }
  return {
    id: e.id,
    query: e.query,
    lang: e.lang,
    ...(typeof e.source === 'string' ? { source: e.source } : {}),
    relevant: e.relevant,
  };
}

export function parseGoldenSet(yamlText: string): GoldenEntry[] {
  const doc: unknown = parse(yamlText);
  if (!Array.isArray(doc)) fail('golden set: document must be a YAML list of entries');
  const entries = doc.map(asEntry);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) fail(`golden set: duplicate id "${entry.id}"`);
    seen.add(entry.id);
  }
  return entries;
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read + parse + validate. Every broken relevant path is collected and
 * reported at once — a moved note is a data error to fix, never a silently
 * unwinnable query (spec: "Relevant-path validation gates the run").
 */
export async function loadGoldenSet(vaultRoot: string): Promise<GoldenEntry[]> {
  const file = goldenSetPath(vaultRoot);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    fail(`golden set not found at ${file}`);
  }
  const entries = parseGoldenSet(text);
  const broken: string[] = [];
  for (const entry of entries) {
    for (const rel of entry.relevant) {
      if (!(await pathExists(path.join(vaultRoot, rel)))) {
        broken.push(`  ${entry.id}: ${rel}`);
      }
    }
  }
  if (broken.length > 0) {
    fail(`golden set has broken relevant paths (fix or update the entries):\n${broken.join('\n')}`);
  }
  return entries;
}
