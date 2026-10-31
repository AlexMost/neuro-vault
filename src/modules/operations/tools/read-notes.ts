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
  ReadNotesResultItemError,
  ReadNotesResultItemSuccess,
} from '../types.js';
import { previewBody } from '../preview-body.js';
import {
  effectiveMode,
  itemKey,
  resolveSelector,
  spanText,
  toRequestItems,
  type PathsItem,
  type Resolved,
  type Selection,
  type Selector,
} from '../selection.js';
import { collapseOutline, entriesWithin, preambleWithin } from '../outline.js';
import { noteStructure, type NoteStructure } from '../../../lib/obsidian/corpus/note-structure.js';
import { frontmatterEnd, splitNoteLines } from '../../../lib/obsidian/corpus/chunker.js';
import type { ReadNotesField, ReadNotesItemSuccess } from '../../../lib/obsidian/vault-reader.js';

export const EMPTY_HEADING_MESSAGE =
  'heading must name a heading block; read a block without a heading with { path, lines: [start, end] }';

/** One `paths` item: a bare path, or `{ path }` with at most one selector of its note. */
const pathItem = z.union([
  z.string().min(1),
  z
    .object({
      path: z.string().min(1),
      heading: z
        .string()
        .refine((s) => s.trim() !== '', { message: EMPTY_HEADING_MESSAGE })
        .optional(),
      lines: z
        .tuple([z.number().int().min(1), z.number().int().min(1)])
        .refine(([a, b]) => a <= b, { message: 'lines: start must not exceed end' })
        .optional(),
    })
    .strict(),
]);

interface Input {
  vault?: string;
  paths: string | PathsItem[];
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
    description: [
      'Read one or more notes in one call. Direct from disk; Obsidian need not run.',
      '',
      'PATHS: `paths` is a vault-relative POSIX path string or an array of 1–50 such paths; duplicates are de-duplicated and results returned in input order.',
      '',
      "LINE COORDINATES: every `lines` in this tool's output is `[start, end]`, file-relative, 1-based, inclusive: frontmatter lines are counted, so the body starts after them, and frontmatter ends on the item's `lines[0] − 1` (a `null` frontmatter above `lines[0]` is YAML that did not parse).",
      '',
      'CONTENT is one value for the whole call, next to `paths` — `{ paths: [...], content: "outline" }`:',
      '- `frontmatter`: `{ path, frontmatter }`.',
      '- `outline`: frontmatter + `lines` (the body span) + `preamble` (`[start, end]` of text before the first heading, only when non-blank) + `outline: [{ heading, level, lines }]` — heading blocks in source order. No body text.',
      '- `preview`: frontmatter + `content` (a bounded slice of the body) + `truncated` flag.',
      '- `full`: frontmatter + `lines` + `content` (the complete body).',
      "Omitting `content`: one distinct path → `full`, two or more → `preview`. Re-read a previewed note with `content: 'full'` before citing or editing it.",
      '',
      'READING THE OUTLINE:',
      "- An entry's `lines` is its whole heading block: the heading line through the line before the next heading of the same or higher level, sub-headings included.",
      '- `heading` is the heading name; `Notes[2]` is the second `Notes` directly under the same parent heading.',
      '- Over 100 entries, the deepest nesting levels are dropped: the item carries `collapsed: true`, and `hidden: n` on an entry means n headings below it (all depths) are not listed.',
      '',
      'One missing or unreadable path does not fail the others — per-item errors come back inline as `error: { code, message }` (`NOT_FOUND` when the note does not exist).',
    ].join('\n'),
    inputShape: {
      paths: z.union([z.string().min(1), z.array(pathItem).min(1).max(50)]),
      content: z.enum(['full', 'outline', 'preview', 'frontmatter']).optional(),
    },
    runForEntry: async (entry, input) => {
      // The registration gate has already enforced the schema: `paths` is a
      // non-empty string or a 1-50 item array, `content` is one of the four
      // modes. What it cannot express — two selectors on one item — fails the
      // call here, before any note is read.
      const requested = toRequestItems(input.paths);

      // Exact de-duplication on the path as sent plus the selector, before
      // normalization; the default mode counts the items that remain.
      const seen = new Set<string>();
      const items = requested.filter((item) => {
        const key = itemKey(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      type Slot =
        | { kind: 'invalid'; item: ReadNotesResultItem }
        | { kind: 'valid'; path: string; mode: ContentMode; selector: Selector };
      const slots: Slot[] = items.map((item): Slot => {
        const mode = effectiveMode(item, items.length, input.content);
        try {
          return {
            kind: 'valid',
            path: normalizePath(item.path),
            mode,
            selector: item.selector,
          };
        } catch (err) {
          const message = err instanceof ToolHandlerError ? err.message : String(err);
          return {
            kind: 'invalid',
            item: { path: item.path, error: { code: 'INVALID_ARGUMENT' as const, message } },
          };
        }
      });

      const valid = slots.filter((s): s is Extract<Slot, { kind: 'valid' }> => s.kind === 'valid');
      // One read per distinct note, however many items name it, with every field any
      // of its items' modes needs.
      const notePaths = [...new Set(valid.map((s) => s.path))];
      const readerItems =
        notePaths.length === 0
          ? []
          : await entry.reader.readNotes({
              paths: notePaths,
              fields: fieldsFor(valid),
            });
      const byPath = new Map(notePaths.map((p, i) => [p, readerItems[i]]));
      // One structure per note, however many of its items select from it.
      const structures = new Map<string, NoteStructure>();
      const structureOf = (item: ReadNotesItemSuccess): NoteStructure => {
        let s = structures.get(item.path);
        if (s === undefined) {
          s = noteStructure(rawOf(item));
          structures.set(item.path, s);
        }
        return s;
      };

      const results: ReadNotesResultItem[] = slots.map((slot) => {
        if (slot.kind === 'invalid') return slot.item;
        const item = byPath.get(slot.path);
        if (item === undefined) {
          throw new Error(`read_notes: the reader returned no item for ${slot.path}`);
        }
        if ('error' in item) return item;
        // A preview still reads the whole note, whatever the item selects.
        if (slot.selector.kind === 'whole' || slot.mode === 'preview') {
          return project(item, slot.mode);
        }
        return projectSelection(item, structureOf(item), slot.selector, slot.mode);
      });

      const errors = results.reduce((n, r) => n + ('error' in r ? 1 : 0), 0);
      return { vault: entry.name, results, count: results.length, errors };
    },
  });
}

const FIELDS_BY_MODE: Record<ContentMode, readonly ReadNotesField[]> = {
  frontmatter: ['frontmatter'],
  outline: ['frontmatter', 'raw'],
  preview: ['frontmatter', 'content'],
  full: ['frontmatter', 'content', 'raw'],
};

/**
 * The reader fields a call needs: every field any of its items' modes reads, and `raw`
 * for any item with a selector — resolving it needs the note's structure in every mode.
 */
function fieldsFor(items: readonly { mode: ContentMode; selector: Selector }[]): ReadNotesField[] {
  const needed = new Set<ReadNotesField>();
  for (const { mode, selector } of items) {
    for (const f of FIELDS_BY_MODE[mode]) needed.add(f);
    if (selector.kind !== 'whole') needed.add('raw');
  }
  return (['frontmatter', 'content', 'raw'] as const).filter((f) => needed.has(f));
}

/** One note read in one mode. */
function project(item: ReadNotesItemSuccess, mode: ContentMode): ReadNotesResultItemSuccess {
  const out: ReadNotesResultItemSuccess = { path: item.path, frontmatter: item.frontmatter };
  if (mode === 'full') {
    out.content = item.content;
    const span = fullSpan(item);
    if (span !== null) out.lines = span;
  } else if (mode === 'outline') {
    const s = noteStructure(rawOf(item));
    if (s.body !== null) out.lines = s.body;
    if (s.preamble !== null) out.preamble = s.preamble;
    const { outline, collapsed } = collapseOutline(entriesWithin(s, s.body));
    out.outline = outline;
    if (collapsed) out.collapsed = true;
  } else if (mode === 'preview') {
    const { content: c, truncated } = previewBody(item.content);
    out.content = c;
    out.truncated = truncated;
  }
  return out;
}

/**
 * One selection of a note, rendered from its resolved span in the item's mode: `full`
 * returns the span's verbatim text, `outline` the heading blocks inside it, and
 * `frontmatter` only the frontmatter. `full` and `outline` echo the span as `lines`,
 * plus `heading` and `level` for a heading selection. The selector is resolved in every
 * mode, so a miss is the same item in each.
 */
function projectSelection(
  item: ReadNotesItemSuccess,
  structure: NoteStructure,
  selector: Selection,
  mode: Exclude<ContentMode, 'preview'>,
): ReadNotesResultItem {
  const r = resolveSelector(structure, selector, item.path);
  if (!r.ok) return selectionMiss(item.path, structure, r);
  const out: ReadNotesResultItemSuccess = { path: item.path, frontmatter: item.frontmatter };
  if (mode === 'frontmatter') return out;
  if (mode === 'full') out.content = spanText(structure, r.span);
  out.lines = r.span;
  if (r.heading !== undefined) out.heading = r.heading;
  if (r.level !== undefined) out.level = r.level;
  if (mode === 'outline') {
    const preamble = preambleWithin(structure, r.span);
    if (preamble !== null) out.preamble = preamble;
    const { outline, collapsed } = collapseOutline(entriesWithin(structure, r.span));
    out.outline = outline;
    if (collapsed) out.collapsed = true;
  }
  return out;
}

/**
 * A selector miss as an error item carrying the retry data for its code. It never
 * carries `frontmatter`, and its shape does not depend on the item's mode.
 */
function selectionMiss(
  path: string,
  structure: NoteStructure,
  r: Extract<Resolved, { ok: false }>,
): ReadNotesResultItemError {
  const miss: ReadNotesResultItemError = { path, error: { code: r.code, message: r.message } };
  if (r.code === 'AMBIGUOUS_MATCH') {
    miss.matches = r.matches;
    return miss;
  }
  if (structure.body !== null) miss.lines = [structure.body[0], structure.body[1]];
  if (r.code === 'HEADING_NOT_FOUND') {
    const { outline, collapsed } = collapseOutline(entriesWithin(structure, structure.body));
    miss.outline = outline;
    if (collapsed) miss.collapsed = true;
  }
  return miss;
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
