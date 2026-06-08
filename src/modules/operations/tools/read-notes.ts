import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { normalizePath, validateReadNotesInput } from '../tool-helpers.js';
import type { ContentMode, ReadNotesResult, ReadNotesResultItem } from '../types.js';
import { previewBody } from '../preview-body.js';
import type { ReadNotesField } from '../../../lib/obsidian/vault-reader.js';
import { describeMultiVault, vaultParamShape } from '../../../lib/vault-param.js';

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
  const inputSchema = z.object({
    ...vaultParamShape(registry),
    paths: z.union([z.string().min(1), z.array(z.string()).min(1).max(50)]),
    content: z.enum(['full', 'preview', 'frontmatter']).optional(),
  });
  return {
    name: 'read_notes',
    title: 'Read Notes',
    description:
      "Read one or more notes in one call. `paths` is a vault-relative POSIX path string or an array of 1–50 such paths; duplicates are de-duplicated and results returned in input order. `content` controls how much of each note's body comes back: `full` returns the complete body, `preview` returns a bounded slice plus a `truncated` flag, `frontmatter` returns no body at all. Frontmatter is always returned. The default is derived from the number of distinct paths: one path → `full`, two or more → `preview`; passing `content` explicitly overrides this. Re-read a previewed note with `content: 'full'` before citing or editing it. One missing or unreadable path does not fail the others — per-item errors come back inline. A single MCP roundtrip with parallel disk reads. Reads are direct from disk and do not require Obsidian to be running." +
      describeMultiVault(
        registry,
        'Pass `vault: "<name>"` to target a specific vault when multiple are registered.',
      ),
    inputSchema,
    handler: async (input) => {
      const entry = resolveVault(input, registry, { tool: 'read_notes' });
      const { paths, content } = validateReadNotesInput(input);

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
        effective === 'frontmatter' ? ['frontmatter'] : ['frontmatter', 'content'];

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
        const out: {
          path: string;
          frontmatter?: Record<string, unknown> | null;
          content?: string;
          truncated?: boolean;
        } = {
          path: item.path,
          frontmatter: item.frontmatter,
        };
        if (effective === 'full') {
          out.content = item.content;
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
        return projected[projectedIdx++]!;
      });

      const errors = results.reduce((n, r) => n + ('error' in r ? 1 : 0), 0);
      return { vault: entry.name, results, count: results.length, errors };
    },
  };
}
