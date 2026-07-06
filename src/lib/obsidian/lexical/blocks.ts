import path from 'node:path';

import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Heading, Nodes, Parent, RootContent } from 'mdast';

import { normalizeWithMap } from './normalize.js';

export interface NoteUnit {
  kind: 'heading' | 'body';
  raw: string;
  norm: string;
  map: number[];
  lines: [number, number];
  heading?: string;
}

export interface ParsedNote {
  title: { raw: string; norm: string; map: number[] };
  units: NoteUnit[];
}

function nodeText(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node) {
    return (node as Parent).children.map((c) => nodeText(c as Nodes)).join('');
  }
  return '';
}

function linesOf(node: Nodes, lineOffset: number): [number, number] {
  const start = (node.position?.start.line ?? 1) + lineOffset;
  const end = (node.position?.end.line ?? start) + lineOffset;
  return [start, end];
}

/** Leaf block types that become body units. Containers below are recursed into. */
const CONTAINER_TYPES = new Set(['list', 'listItem', 'blockquote']);

export function parseNote(opts: { path: string; body: string; lineOffset: number }): ParsedNote {
  const titleRaw = path.basename(opts.path, '.md');
  const titleNorm = normalizeWithMap(titleRaw);

  const units: NoteUnit[] = [];
  let currentHeading: string | undefined;

  const visit = (nodes: RootContent[]): void => {
    for (const node of nodes) {
      if (node.type === 'heading') {
        const raw = nodeText(node as Heading).trim();
        if (raw.length > 0) {
          const { norm, map } = normalizeWithMap(raw);
          units.push({ kind: 'heading', raw, norm, map, lines: linesOf(node, opts.lineOffset) });
        }
        currentHeading = raw.length > 0 ? raw : currentHeading;
        continue;
      }
      if (CONTAINER_TYPES.has(node.type) && 'children' in node) {
        visit((node as Parent).children as RootContent[]);
        continue;
      }
      if (node.type === 'paragraph' || node.type === 'code' || node.type === 'table') {
        const raw = nodeText(node).trim();
        if (raw.length === 0) continue;
        const { norm, map } = normalizeWithMap(raw);
        units.push({
          kind: 'body',
          raw,
          norm,
          map,
          lines: linesOf(node, opts.lineOffset),
          heading: currentHeading,
        });
      }
    }
  };

  visit(fromMarkdown(opts.body).children);

  return { title: { raw: titleRaw, ...titleNorm }, units };
}
