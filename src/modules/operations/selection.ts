import { ToolHandlerError } from '../../lib/tool-response.js';
import type { ContentMode } from './types.js';

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
