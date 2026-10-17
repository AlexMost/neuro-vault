import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { buildSingleVaultTool } from '../../../lib/single-vault-tool.js';
import type { SimilarityDefaults } from '../../../lib/model-profiles.js';
import type { ICorpusReader } from '../../../lib/obsidian/corpus/corpus.js';
import { CorpusNotReadyError } from '../../../lib/obsidian/semantic-backend.js';
import { compareStrings } from '../../../lib/obsidian/corpus/scoring.js';
import { readThreshold } from '../tool-helpers.js';
import type { DuplicatePair } from '../types.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';

interface Input {
  vault?: string;
  threshold?: number;
}

type StampedDuplicatePair = DuplicatePair & { vault: string };

export interface FindDuplicatesDeps {
  registry: IVaultRegistry;
  modelKey: string;
  similarity: SimilarityDefaults;
}

/** How many notes one `nearest` read carries as anchors. */
export const DUPLICATE_ANCHOR_BATCH = 64;

function comparePairs(left: DuplicatePair, right: DuplicatePair): number {
  return (
    right.similarity - left.similarity ||
    compareStrings(left.note_a, right.note_a) ||
    compareStrings(left.note_b, right.note_b)
  );
}

/**
 * Every pair of notes at or above `threshold`, each reported once with `note_a` before
 * `note_b`: every anchor's neighbours, the anchor's own hit dropped, each pair folded to its
 * ordered form (the other anchor of the pair finds it again). An anchor without a vector has
 * no list and no pairs.
 */
async function collectDuplicatePairs(args: {
  corpus: ICorpusReader;
  anchors: readonly string[];
  threshold: number;
}): Promise<DuplicatePair[]> {
  const pairs = new Map<string, DuplicatePair>();
  for (let start = 0; start < args.anchors.length; start += DUPLICATE_ANCHOR_BATCH) {
    const batch = args.anchors.slice(start, start + DUPLICATE_ANCHOR_BATCH);
    const lists = await args.corpus.nearest(
      batch.map((path) => ({ path })),
      { threshold: args.threshold },
    );
    batch.forEach((anchor, index) => {
      for (const hit of lists[index] ?? []) {
        if (hit.path === anchor) continue;
        const ordered = compareStrings(anchor, hit.path) <= 0;
        const note_a = ordered ? anchor : hit.path;
        const note_b = ordered ? hit.path : anchor;
        const key = `${note_a}\0${note_b}`;
        if (!pairs.has(key)) pairs.set(key, { note_a, note_b, similarity: hit.similarity });
      }
    });
  }
  return [...pairs.values()].sort(comparePairs);
}

export function buildFindDuplicatesTool(
  deps: FindDuplicatesDeps,
): ITool<Input, StampedDuplicatePair[]> {
  const { registry, modelKey, similarity } = deps;
  return buildSingleVaultTool<Input, StampedDuplicatePair[]>(registry, {
    name: 'find_duplicates',
    title: 'Find Duplicates',
    description: 'Identify note pairs with high embedding similarity.',
    semantic: true,
    inputShape: {
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          `Min note↔note similarity 0-1 for a pair to count as a duplicate. Default ${similarity.duplicates}, on the active embedding model's scale.`,
        ),
    },
    runForEntry: async (entry, input) => {
      const threshold = readThreshold(input.threshold, similarity.duplicates, 'threshold');
      try {
        const pairs = await collectDuplicatePairs({
          corpus: entry.backend,
          anchors: await entry.reader.scan(),
          threshold,
        });
        const existing = await entry.filterExisting(pairs.flatMap((p) => [p.note_a, p.note_b]));
        return pairs
          .filter((p) => existing.has(p.note_a) && existing.has(p.note_b))
          .map((p) => ({ vault: entry.name, ...p }));
      } catch (error) {
        // A corpus that stopped serving after the readiness gate let the call in
        // is the dispatcher's to report, as the gate would.
        if (error instanceof ToolHandlerError || error instanceof CorpusNotReadyError) throw error;
        throw new ToolHandlerError('DEPENDENCY_ERROR', 'Failed to find duplicate notes', {
          details: { modelKey, operation: 'find_duplicates' },
          cause: error,
        });
      }
    },
  });
}
