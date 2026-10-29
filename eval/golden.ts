import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

import { FsVaultReader } from '../src/lib/obsidian/vault-reader.js';
import { loadVaultScope } from '../src/lib/obsidian/vault-scope-config.js';
import { MAX_MULTI_QUERIES } from '../src/modules/semantic/tool-helpers.js';

export const QUERY_CLASSES = ['concept', 'name', 'single_token', 'control'] as const;
export type QueryClass = (typeof QUERY_CLASSES)[number];

/** `mixed` is one call carrying UA and EN strings — cross-language is a language slice. */
export const LANGS = ['ua', 'en', 'mixed'] as const;
export type Lang = (typeof LANGS)[number];

export interface GoldenEntry {
  id: string;
  /**
   * One `search_notes` call: a string, or an array passed as `queries` (relevance is
   * judged per call). Normalised the way the tool normalises it — trimmed, an array
   * de-duplicated in order.
   */
  query: string | string[];
  class: QueryClass;
  lang: Lang;
  source?: string;
  /** Empty exactly when `class` is `control`: a control query has no answer in the vault. */
  relevant: string[];
}

/** The strings one entry's call sends. */
export function queriesOf(entry: GoldenEntry): string[] {
  return typeof entry.query === 'string' ? [entry.query] : entry.query;
}

export function isControl(entry: GoldenEntry): boolean {
  return entry.class === 'control';
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
  const query = asQuery(e.query, label(e.id));
  if (!QUERY_CLASSES.includes(e.class as QueryClass))
    fail(`golden set: ${label(e.id)} has unknown class (expected ${QUERY_CLASSES.join(', ')})`);
  const entryClass = e.class as QueryClass;
  if (!LANGS.includes(e.lang as Lang))
    fail(`golden set: ${label(e.id)} has unknown lang (expected ${LANGS.join(', ')})`);
  if (
    !Array.isArray(e.relevant) ||
    !e.relevant.every((p): p is string => typeof p === 'string' && p !== '')
  ) {
    fail(`golden set: ${label(e.id)} needs a relevant list of paths`);
  }
  // The control rule, both ways: an answerable entry with no labels would score as a
  // miss, and a control with labels would never be read as noise.
  if (entryClass === 'control' && e.relevant.length > 0)
    fail(`golden set: ${label(e.id)} is a control query and must have relevant: []`);
  if (entryClass !== 'control' && e.relevant.length === 0)
    fail(`golden set: ${label(e.id)} has relevant: [] but is not class: control`);
  return {
    id: e.id,
    query,
    class: entryClass,
    lang: e.lang as Lang,
    ...(typeof e.source === 'string' ? { source: e.source } : {}),
    relevant: e.relevant,
  };
}

/** The tool's own query rules (`normalizeQuery` / `normalizeQueryArray`), as golden-set errors. */
function asQuery(raw: unknown, label: string): string | string[] {
  if (typeof raw === 'string') {
    if (raw.trim() === '') fail(`golden set: ${label} is missing query`);
    return raw.trim();
  }
  if (!Array.isArray(raw)) fail(`golden set: ${label} is missing query`);
  if (raw.length === 0 || raw.length > MAX_MULTI_QUERIES)
    fail(`golden set: ${label} needs a query array of 1..${MAX_MULTI_QUERIES} strings`);
  if (!raw.every((q): q is string => typeof q === 'string' && q.trim() !== ''))
    fail(`golden set: ${label} has an empty or non-string query in its array`);
  return [...new Set(raw.map((q) => q.trim()))];
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

/** The vault's scoped note listing — the one the corpus and the lexical index are built from. */
export async function scanVault(vaultRoot: string): Promise<Set<string>> {
  const scope = await loadVaultScope(vaultRoot);
  const reader = new FsVaultReader({ vaultRoot, scope });
  return new Set(await reader.scan());
}

/**
 * Read + parse + validate. Every broken relevant path is collected and
 * reported at once — a moved note is a data error to fix, never a silently
 * unwinnable query (spec: "Relevant-path validation gates the run").
 *
 * Membership is checked against the **scoped vault listing**, not the
 * filesystem. `fs.access` on the joined path is a strictly weaker gate: on a
 * case-insensitive volume `Notes/Foo.md` passes it while the corpus and the
 * lexical index carry `Notes/foo.md`; a scope-excluded or dot-segment note
 * exists on disk but is in neither index; and `../outside.md` resolves fine.
 * Each of those becomes a permanently unwinnable query — the silent metric
 * degradation this gate exists to prevent.
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
  const known = await scanVault(vaultRoot);
  const broken: string[] = [];
  for (const entry of entries) {
    for (const rel of entry.relevant) {
      if (!known.has(rel)) {
        broken.push(`  ${entry.id}: ${rel}`);
      }
    }
  }
  if (broken.length > 0) {
    fail(
      'golden set has relevant paths that are not in the vault (or excluded by scope) — ' +
        `fix or update the entries:\n${broken.join('\n')}`,
    );
  }
  return entries;
}
