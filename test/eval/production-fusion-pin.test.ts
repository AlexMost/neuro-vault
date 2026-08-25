import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FsVaultReader } from '../../src/lib/obsidian/vault-reader.js';
import { loadVaultScope } from '../../src/lib/obsidian/vault-scope-config.js';
import { WikilinkGraphIndex } from '../../src/lib/obsidian/wikilink-graph.js';
import {
  findBlockNeighbors,
  findDuplicates,
  findNeighbors,
} from '../../src/modules/semantic/search-engine.js';
import {
  buildSearchNotesTool,
  type SearchNotesOutput,
} from '../../src/modules/semantic/tools/search-notes.js';
import type { SmartSource } from '../../src/modules/semantic/types.js';
import { EVAL_TOP_K, createFusedContext, rankQuery } from '../../eval/pipelines.js';
import { makeFakeCorpusIndex, makeTestRegistry } from '../semantic/tools/_helpers.js';

// The harness's central validity claim: a `fused` eval run measures the REAL
// production ordering, not a reimplementation of it. Nothing else in the suite
// fails if `assembleUnified` grows a leg, reweights, or reorders — every
// eval/ test would stay green while the harness silently stopped measuring
// production. So rank one query two ways over one fixture vault and assert the
// two path orders are identical:
//
//   production  search_notes({ effort: 'deep', threshold: 0, limit: 10 })
//   harness     rankQuery({ pipeline: 'fused' })
//
// Every corpus path exists on disk, which makes production's `filterExisting`
// a no-op and the two orderings genuinely comparable. Both sides get a real
// FsVaultReader/WikilinkGraphIndex over the same vault and the real search
// engine, so only the fusion wiring is under test.

const NOTE_COUNT = 10;
const QUERY = 'quirkyterm';
const QUERY_VECTOR = [1, 0, 0];

const notePath = (i: number): string => `Notes/n${i}.md`;

// Unit vectors fanned away from the query vector. Every note clears threshold
// 0; the semantic pool (8) takes n0..n7 as seeds, leaving n8/n9 as the only
// expansion candidates — so all three fusion legs are non-empty and disagree.
function vecFor(i: number): number[] {
  const t = i / NOTE_COUNT;
  return [Math.cos(t), Math.sin(t), 0];
}

// `quirkyterm` lands in three different lexical tiers, one of them on a note
// with no vector at all (lexical-only) and one on an expansion candidate — so
// the fused list interleaves legs instead of echoing the semantic order.
const LEXICAL_ONLY = 'Notes/lexical-only quirkyterm.md';

function bodyFor(i: number): string {
  if (i === 3) return `# n3\n\n## quirkyterm section\n\nsome prose\n`;
  if (i === 9) return `# n9\n\nprose mentioning quirkyterm inline\n`;
  // Two backlinks onto n9 so the lexical leg's backlink tie-break is fed by a
  // real graph on both sides, not a stub.
  if (i === 5 || i === 6) return `# n${i}\n\nsee [[n9]]\n`;
  return `# n${i}\n\nfiller prose\n`;
}

const embed = (_text: string): Promise<number[]> => Promise.resolve(QUERY_VECTOR);

async function makeFixtureVault(): Promise<{
  vaultRoot: string;
  sources: Map<string, SmartSource>;
}> {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-fusion-pin-'));
  await mkdir(path.join(vaultRoot, 'Notes'), { recursive: true });
  const sources = new Map<string, SmartSource>();
  for (let i = 0; i < NOTE_COUNT; i++) {
    const rel = notePath(i);
    await writeFile(path.join(vaultRoot, rel), bodyFor(i));
    sources.set(rel, { path: rel, embedding: vecFor(i), blocks: [] });
  }
  await writeFile(path.join(vaultRoot, LEXICAL_ONLY), '# lexical only\n\nno vector here\n');
  return { vaultRoot, sources };
}

async function productionOrder(
  vaultRoot: string,
  sources: Map<string, SmartSource>,
): Promise<SearchNotesOutput> {
  const scope = await loadVaultScope(vaultRoot);
  const reader = new FsVaultReader({ vaultRoot, scope });
  const registry = makeTestRegistry([
    {
      name: 'v',
      path: vaultRoot,
      smartEnvPath: path.join(vaultRoot, '.smart-env'),
      reader,
      corpus: makeFakeCorpusIndex(sources),
      graph: new WikilinkGraphIndex({ reader }),
      semanticAvailable: true,
    },
  ]);
  const tool = buildSearchNotesTool({
    registry,
    embeddingProvider: { initialize: () => Promise.resolve(), embed },
    searchEngine: { findNeighbors, findBlockNeighbors, findDuplicates },
    modelKey: 'k',
  });
  return (await tool.handler({
    query: QUERY,
    effort: 'deep',
    threshold: 0,
    limit: EVAL_TOP_K,
  })) as SearchNotesOutput;
}

describe('fused pipeline pins the production fused ordering', () => {
  let vaultRoot: string;
  afterEach(async () => rm(vaultRoot, { recursive: true, force: true }));

  it('ranks a query identically to search_notes at deep effort, threshold 0', async () => {
    const fixture = await makeFixtureVault();
    vaultRoot = fixture.vaultRoot;

    const production = await productionOrder(vaultRoot, fixture.sources);
    const expected = production.matches.map((m) => m.path);

    const fusedContext = await createFusedContext(vaultRoot);
    const actual = await rankQuery({
      pipeline: 'fused',
      query: QUERY,
      sources: fixture.sources,
      embed,
      fusedContext,
    });

    expect(actual).toEqual(expected);

    // Non-vacuity: the fixture must actually exercise all three legs and a
    // non-trivial interleaving, or the equality above proves nothing.
    expect(expected).toHaveLength(EVAL_TOP_K);
    const legs = new Set(production.matches.flatMap((m) => m.found_in.map((f) => f.split(':')[0])));
    expect([...legs].sort()).toEqual(['expansion', 'lexical', 'semantic']);
    // A note only the lexical leg knows about, and one only the expansion leg
    // knows about, both survive into the fused top-10.
    expect(actual).toContain(LEXICAL_ONLY);
    expect(actual).toContain(notePath(8));
    // The fused order is not simply the semantic order.
    expect(actual).not.toEqual([...fixture.sources.keys()].slice(0, EVAL_TOP_K));
  });
});
