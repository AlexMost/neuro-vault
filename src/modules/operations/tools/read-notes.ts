import { z } from 'zod';

import { READ_ONLY_TOOL } from '../../../lib/tool-annotations.js';
import type { ITool } from '../../../lib/tool-registry.js';
import { buildSingleVaultTool } from '../../../lib/single-vault-tool.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { normalizePath } from '../tool-helpers.js';
import type {
  ContentMode,
  ReadNotesResult,
  ReadNotesResultItem,
  ReadNotesResultItemSuccess,
} from '../types.js';
import { previewBody } from '../preview-body.js';
import { entriesWithin } from '../outline.js';
import { noteStructure } from '../../../lib/obsidian/corpus/note-structure.js';
import { frontmatterEnd, splitNoteLines } from '../../../lib/obsidian/corpus/chunker.js';
import type { ReadNotesField, ReadNotesItemSuccess } from '../../../lib/obsidian/vault-reader.js';

interface Input {
  vault?: string;
  paths: string | string[];
  content?: ContentMode;
}

export interface ReadNotesDeps {
  registry: IVaultRegistry;
}

export function buildReadNotesTool(
  deps: ReadNotesDeps,
): ITool<Input, { vault: string } & ReadNotesResult> {
  const { registry } = deps;
  return buildSingleVaultTool<Input, { vault: string } & ReadNotesResult>(registry, {
    name: 'read_notes',
    title: 'Read Notes',
    annotations: READ_ONLY_TOOL,
    description:
      "Read one or more notes in one call. `paths` is a vault-relative POSIX path string or an array of 1–50 such paths; duplicates are de-duplicated and results returned in input order. `content` controls how much of each note's body comes back: `full` returns the complete body, `preview` returns a bounded slice plus a `truncated` flag, `frontmatter` returns no body at all. Frontmatter is always returned. The default is derived from the number of distinct paths: one path → `full`, two or more → `preview`; passing `content` explicitly overrides this. Re-read a previewed note with `content: 'full'` before citing or editing it. One missing or unreadable path does not fail the others — per-item errors come back inline. A single MCP roundtrip with parallel disk reads. Reads are direct from disk and do not require Obsidian to be running.",
    inputShape: {
      paths: z.union([z.string().min(1), z.array(z.string()).min(1).max(50)]),
      content: z.enum(['full', 'outline', 'preview', 'frontmatter']).optional(),
    },
    runForEntry: async (entry, input) => {
      // The registration gate has already enforced the schema: `paths` is a
      // non-empty string or a 1-50 string array, `content` is one of the four
      // modes. All that is left is widening the single-string form.
      const paths = typeof input.paths === 'string' ? [input.paths] : input.paths;
      const content = input.content;

      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const p of paths) {
        if (!seen.has(p)) {
          seen.add(p);
          deduped.push(p);
        }
      }

      const effective = content ?? (deduped.length === 1 ? 'full' : 'preview');
      const fields: ReadNotesField[] =
        effective === 'frontmatter'
          ? ['frontmatter']
          : effective === 'outline'
            ? ['frontmatter', 'raw']
            : ['frontmatter', 'content', 'raw'];

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
        validPaths.length === 0 ? [] : await entry.reader.readNotes({ paths: validPaths, fields });

      const projected: ReadNotesResultItem[] = readerItems.map((item) => {
        if ('error' in item) {
          return item;
        }
        const out: ReadNotesResultItemSuccess = {
          path: item.path,
          frontmatter: item.frontmatter,
        };
        if (effective === 'full') {
          out.content = item.content;
          const span = fullSpan(item);
          if (span !== null) out.lines = span;
        } else if (effective === 'outline') {
          const s = noteStructure(rawOf(item));
          if (s.body !== null) out.lines = s.body;
          if (s.preamble !== null) out.preamble = s.preamble;
          out.outline = entriesWithin(s, s.body);
        } else if (effective === 'preview') {
          const { content: c, truncated } = previewBody(item.content);
          out.content = c;
          out.truncated = truncated;
        }
        return out;
      });

      let projectedIdx = 0;
      const results: ReadNotesResultItem[] = slots.map((slot) => {
        if (slot.kind === 'invalid') return slot.item;
        return projected[projectedIdx++];
      });

      const errors = results.reduce((n, r) => n + ('error' in r ? 1 : 0), 0);
      return { vault: entry.name, results, count: results.length, errors };
    },
  });
}

/** The whole file the reader returned; the handler always requests it for a body mode. */
function rawOf(item: ReadNotesItemSuccess): string {
  if (item.raw === undefined) {
    throw new Error(`read_notes: the reader returned no raw text for ${item.path}`);
  }
  return item.raw;
}

/**
 * The span of the text a `full` read returns. That is the body after the frontmatter,
 * unless the frontmatter fence holds YAML that failed to parse: the reader then returns
 * the raw file as `content`, so the span is every line of it. `null` for an empty note
 * or a frontmatter-only one, which have no body line. It uses the same frontmatter and
 * line helpers as `noteStructure`, without its markdown parse, so a full read stays cheap.
 */
function fullSpan(item: ReadNotesItemSuccess): [number, number] | null {
  const raw = rawOf(item);
  const fmEnd = frontmatterEnd(raw);
  const n = splitNoteLines(raw).length;
  if (item.frontmatter === null && fmEnd > 0) return [1, n];
  return raw !== '' && fmEnd < n ? [fmEnd + 1, n] : null;
}
