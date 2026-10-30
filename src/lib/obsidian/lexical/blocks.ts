import path from 'node:path';

import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes, Parent, RootContent } from 'mdast';

import { normalizeText } from './normalize.js';

export interface NoteUnit {
  kind: 'heading' | 'body';
  raw: string;
  norm: string;
  lines: [number, number];
  heading?: string;
}

export interface ParsedNote {
  title: { raw: string; norm: string };
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

  const units: NoteUnit[] = [];
  let currentHeading: string | undefined;

  const visit = (nodes: RootContent[]): void => {
    for (const node of nodes) {
      if (node.type === 'heading') {
        const raw = nodeText(node).trim();
        if (raw.length > 0) {
          units.push({
            kind: 'heading',
            raw,
            norm: normalizeText(raw),
            lines: linesOf(node, opts.lineOffset),
          });
        }
        currentHeading = raw.length > 0 ? raw : currentHeading;
        continue;
      }
      if (CONTAINER_TYPES.has(node.type) && 'children' in node) {
        visit((node as Parent).children);
        continue;
      }
      // An Excalidraw drawing's encoded payload; its Text Elements stay units.
      if (node.type === 'code' && node.lang === 'compressed-json') continue;
      if (node.type === 'paragraph' || node.type === 'code' || node.type === 'table') {
        const raw = nodeText(node).trim();
        if (raw.length === 0) continue;
        units.push({
          kind: 'body',
          raw,
          norm: normalizeText(raw),
          lines: linesOf(node, opts.lineOffset),
          heading: currentHeading,
        });
      }
    }
  };

  visit(fromMarkdown(opts.body).children);

  return { title: { raw: titleRaw, norm: normalizeText(titleRaw) }, units };
}
