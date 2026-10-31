import { ToolHandlerError } from '../../lib/tool-response.js';
import type { NoteStructure } from '../../lib/obsidian/corpus/note-structure.js';
import type { ContentMode, OutlineEntry, SelectorMissCode } from './types.js';

/** What one `read_notes` item reads of its note: the whole body, one heading block, or a range. */
export type Selector =
  | { kind: 'whole' }
  | { kind: 'heading'; heading: string }
  | { kind: 'lines'; lines: [number, number] };

/** One request item: a path as sent (not yet normalized) and its selector. */
export interface ReadRequestItem {
  path: string;
  selector: Selector;
}

/** A `paths` item as the input gate hands it over. */
export type PathsItem = string | { path: string; heading?: string; lines?: [number, number] };

/**
 * The request items, one per `paths` item in input order. A `{ path }` object with no
 * selector is the bare path. An item naming both `heading` and `lines` is a fault the
 * schema cannot express, so it fails the whole call with `INVALID_ARGUMENT`.
 */
export function toRequestItems(paths: string | PathsItem[]): ReadRequestItem[] {
  const list = typeof paths === 'string' ? [paths] : paths;
  return list.map((p): ReadRequestItem => {
    if (typeof p === 'string') return { path: p, selector: { kind: 'whole' } };
    if (p.heading !== undefined && p.lines !== undefined) {
      throw new ToolHandlerError(
        'INVALID_ARGUMENT',
        `an item names one selection: pass either heading or lines, not both (${p.path})`,
      );
    }
    if (p.heading !== undefined) {
      return { path: p.path, selector: { kind: 'heading', heading: p.heading } };
    }
    if (p.lines !== undefined) {
      return { path: p.path, selector: { kind: 'lines', lines: [p.lines[0], p.lines[1]] } };
    }
    return { path: p.path, selector: { kind: 'whole' } };
  });
}

/** An item's identity for exact de-duplication: its path as sent and its selector. */
export function itemKey(item: ReadRequestItem): string {
  const { path, selector } = item;
  switch (selector.kind) {
    case 'whole':
      return JSON.stringify([path, 'whole']);
    case 'heading':
      return JSON.stringify([path, 'heading', selector.heading]);
    case 'lines':
      return JSON.stringify([path, 'lines', selector.lines[0], selector.lines[1]]);
  }
}

/**
 * The mode one item is read in. An explicit `content` applies to every item. Without one,
 * a selector item reads `full`, and a bare path reads `full` only when it is the call's
 * one item — `itemCount` counts every item after de-duplication, selector items included.
 */
export function effectiveMode(
  item: ReadRequestItem,
  itemCount: number,
  explicit?: ContentMode,
): ContentMode {
  if (explicit !== undefined) return explicit;
  if (item.selector.kind !== 'whole') return 'full';
  return itemCount === 1 ? 'full' : 'preview';
}

/**
 * What a selector names in one note: the span of the selection, or a miss with the
 * message that states its cause and the retry. A heading selection also carries the
 * resolved heading name and its level.
 */
export type Resolved =
  | { ok: true; span: [number, number]; heading?: string; level?: number }
  | { ok: false; code: 'AMBIGUOUS_MATCH'; message: string; matches: OutlineEntry[] }
  | {
      ok: false;
      code: Exclude<SelectorMissCode, 'AMBIGUOUS_MATCH'>;
      message: string;
    };

/** `lines a–b`, or `line a` for a one-line span: the way a miss message names a span. */
const spanLabel = ([a, b]: readonly [number, number]): string =>
  a === b ? `line ${a}` : `lines ${a}–${b}`;

/** A selector that names part of its note: a heading block or a line range. */
export type Selection = Exclude<Selector, { kind: 'whole' }>;

/**
 * Resolves a selector against the note's structure. A `lines` range is clipped to the
 * body at both ends; only a range sharing no line with the body is `LINES_OUT_OF_RANGE`.
 * A `heading` names one heading block by its heading name. `path` names the note in a
 * miss message. `unparsedFrontmatter` says the note's frontmatter fence holds YAML that
 * did not parse: a frontmatter read then returns `null`, so a miss in or around the fence
 * points at a whole-note read, which returns the fence as text, instead.
 */
export function resolveSelector(
  structure: NoteStructure,
  selector: Selection,
  path: string,
  { unparsedFrontmatter = false }: { unparsedFrontmatter?: boolean } = {},
): Resolved {
  return selector.kind === 'lines'
    ? resolveLines(structure, selector.lines, path, unparsedFrontmatter)
    : resolveHeading(structure, selector.heading, path, unparsedFrontmatter);
}

/** A miss's cause and retry for a note with frontmatter and no body. */
function frontmatterOnly(structure: NoteStructure, unparsed: boolean): string {
  const fence = spanLabel([1, structure.frontmatterEnd]);
  return unparsed
    ? `the note has a frontmatter fence whose YAML does not parse (${fence}) and no body; ` +
        "read the note whole with content: 'full'"
    : `the note has frontmatter (${fence}) and no body; ` +
        "read the frontmatter with content: 'frontmatter'";
}

/**
 * A heading name compared loosely: a leading `#{1,6}` and the space after it dropped,
 * wikilinks and Markdown links reduced to their display text, emphasis and code markup
 * (`**`, `__`, `*`, `_`, backticks) removed, whitespace collapsed, trimmed, and
 * case-folded. Folding is NFC, then lower, upper and lower case again: non-Latin
 * names compare, `ß`, `ẞ` and `SS` meet, a final `ς` meets `σ`, a ligature meets its
 * letters (`ﬁ` meets `fi`), and the dotless `ı` meets `i`. Emoji and punctuation stay.
 */
export function normalizeHeadingName(s: string): string {
  return s
    .normalize('NFC')
    .trim()
    .replace(/^#{1,6}[ \t]+/, '')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .toUpperCase()
    .toLowerCase();
}

/**
 * Exact heading names first; only when none matches exactly, the normalized names, and
 * then only a single hit resolves. Level is ignored, and a prefix never matches. Every
 * heading block counts, including one a collapsed outline does not list.
 */
function resolveHeading(
  structure: NoteStructure,
  name: string,
  path: string,
  unparsedFrontmatter: boolean,
): Resolved {
  const { headings } = structure;
  let hits = headings.filter((h) => h.heading === name);
  if (hits.length === 0) {
    const wanted = normalizeHeadingName(name);
    hits = headings.filter((h) => normalizeHeadingName(h.heading) === wanted);
  }
  const quoted = JSON.stringify(name);
  if (hits.length === 1) {
    const [h] = hits;
    return { ok: true, span: [h.lines[0], h.lines[1]], heading: h.heading, level: h.level };
  }
  if (hits.length === 0) {
    const missing = `no heading block of ${path} is named ${quoted}`;
    let message: string;
    if (structure.body === null) {
      message =
        structure.frontmatterEnd === 0
          ? `${missing}: the note is empty and has nothing to read`
          : `${missing}: ${frontmatterOnly(structure, unparsedFrontmatter)}`;
    } else if (headings.length === 0) {
      message =
        `${missing}: the note has no headings; ` +
        'read it whole, or a range with { path, lines: [start, end] }';
    } else {
      message = `${missing}, exactly or ignoring case and markup; retry with a heading name from outline`;
    }
    return { ok: false, code: 'HEADING_NOT_FOUND', message };
  }
  const spans = hits.map((h) => spanLabel(h.lines)).join(', ');
  return {
    ok: false,
    code: 'AMBIGUOUS_MATCH',
    message:
      `heading ${quoted} matches ${hits.length} heading blocks of ${path} (${spans}); ` +
      'read the one you want with { path, lines: [start, end] } from matches',
    matches: hits.map((h) => ({
      heading: h.heading,
      level: h.level,
      lines: [h.lines[0], h.lines[1]],
    })),
  };
}

function resolveLines(
  structure: NoteStructure,
  requested: [number, number],
  path: string,
  unparsedFrontmatter: boolean,
): Resolved {
  const miss = (message: string): Resolved => ({ ok: false, code: 'LINES_OUT_OF_RANGE', message });
  const one = requested[0] === requested[1];
  const asked = `${spanLabel(requested)} of ${path}`;
  const [are, lie] = one ? ['is', 'lies'] : ['are', 'lie'];
  const { body, frontmatterEnd } = structure;
  if (body === null) {
    return frontmatterEnd === 0
      ? miss(`${asked} ${are} out of range: the note is empty and has no line to read`)
      : miss(`${asked} ${are} out of range: ${frontmatterOnly(structure, unparsedFrontmatter)}`);
  }
  const start = Math.max(requested[0], body[0]);
  const end = Math.min(requested[1], body[1]);
  if (start <= end) return { ok: true, span: [start, end] };
  const bodySpan = `body: ${spanLabel(body)}`;
  if (requested[1] < body[0]) {
    return miss(
      unparsedFrontmatter
        ? `${asked} ${lie} in a frontmatter fence whose YAML does not parse (${bodySpan}); ` +
            "read the note whole with content: 'full', or a range inside the body"
        : `${asked} ${lie} in the frontmatter (${bodySpan}); ` +
            "read the frontmatter with content: 'frontmatter', or a range inside the body",
    );
  }
  return miss(
    `${asked} ${lie} past the end of the note (${bodySpan}); retry with a range inside the body`,
  );
}

/**
 * The text of a span, verbatim. A CRLF note's lines keep their `\r`, so the interior
 * line endings stay CRLF; the last line's `\r` is dropped, since the span ends there.
 */
export function spanText(structure: NoteStructure, [start, end]: [number, number]): string {
  return structure.lines
    .slice(start - 1, end)
    .join('\n')
    .replace(/\r$/, '');
}
