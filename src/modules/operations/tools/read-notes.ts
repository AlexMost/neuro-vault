import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { normalizePath, validateReadNotesInput } from '../tool-helpers.js';
import type { ReadNotesResult, ReadNotesResultItem } from '../types.js';
import type { VaultReader } from '../vault-reader.js';

const readNotesFieldSchema = z.enum(['frontmatter', 'content']);
const inputSchema = z.object({
  paths: z.union([z.string().min(1), z.array(z.string()).min(1).max(50)]),
  fields: z.array(readNotesFieldSchema).min(1).optional(),
});

type Input = z.infer<typeof inputSchema>;

export interface ReadNotesDeps {
  reader: VaultReader;
}

export function buildReadNotesTool(deps: ReadNotesDeps): ITool<Input, ReadNotesResult> {
  const { reader } = deps;
  return {
    name: 'read_notes',
    title: 'Read Notes',
    description:
      "Read one or more notes in one call. `paths` is a vault-relative POSIX path string or an array of 1–50 such paths; duplicates are de-duplicated and results returned in input order. `fields` projects which parts of each note to return — choose from `frontmatter` and `content`; default `['frontmatter','content']`. One missing or unreadable path does not fail the others — per-item errors come back inline. A single MCP roundtrip with parallel disk reads. Reads are direct from disk and do not require Obsidian to be running.",
    inputSchema,
    handler: async (input) => {
      const { paths, fields } = validateReadNotesInput(input);

      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const p of paths) {
        if (!seen.has(p)) {
          seen.add(p);
          deduped.push(p);
        }
      }

      type Slot = { kind: 'invalid'; item: ReadNotesResultItem } | { kind: 'valid'; path: string };
      const slots: Slot[] = deduped.map((raw) => {
        try {
          const normalized = normalizePath(raw);
          return { kind: 'valid', path: normalized };
        } catch (err) {
          const message = err instanceof ToolHandlerError ? err.message : String(err);
          return {
            kind: 'invalid',
            item: { path: raw, error: { code: 'INVALID_ARGUMENT' as const, message } },
          };
        }
      });

      const validPaths = slots
        .filter((s): s is { kind: 'valid'; path: string } => s.kind === 'valid')
        .map((s) => s.path);

      const readerItems =
        validPaths.length === 0 ? [] : await reader.readNotes({ paths: validPaths, fields });

      const projected: ReadNotesResultItem[] = readerItems.map((item) => {
        if ('error' in item) {
          return item;
        }
        const out: {
          path: string;
          frontmatter?: Record<string, unknown> | null;
          content?: string;
        } = {
          path: item.path,
        };
        if (fields.includes('frontmatter')) {
          out.frontmatter = item.frontmatter;
        }
        if (fields.includes('content')) {
          out.content = item.content;
        }
        return out;
      });

      let projectedIdx = 0;
      const results: ReadNotesResultItem[] = slots.map((slot) => {
        if (slot.kind === 'invalid') return slot.item;
        return projected[projectedIdx++]!;
      });

      const errors = results.reduce((n, r) => n + ('error' in r ? 1 : 0), 0);
      return { results, count: results.length, errors };
    },
  };
}
