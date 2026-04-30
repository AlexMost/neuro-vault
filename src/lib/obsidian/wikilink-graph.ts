import { extractWikilinksFromFrontmatter } from './frontmatter-links.js';
import { buildBasenameIndex, type BasenameIndex } from './link-resolver.js';
import type { VaultReader } from './vault-reader.js';
import { normalizeWikilinkTarget, parseWikilinks } from './wikilink.js';

export interface OutgoingLink {
  target: string;
  resolved: boolean;
  path?: string;
}

export interface IncomingLink {
  source: string;
}

export interface NoteLinks {
  incoming: IncomingLink[];
  outgoing: OutgoingLink[];
}

export interface WikilinkGraphIndexOptions {
  reader: VaultReader;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 3 * 60 * 1000;
const READ_BATCH_SIZE = 32;

interface NoteAdjacency {
  outgoing: OutgoingLink[];
  incoming: IncomingLink[];
}

// In-memory wikilink graph over the vault. Tracks resolved + unresolved
// outgoing links and resolved incoming links per note; embeds (`![[X]]`) and
// regular wikilinks are recorded uniformly. Built lazily on first query and
// rebuilt synchronously when `ensureFresh()` runs after the TTL has passed.
export class WikilinkGraphIndex {
  private readonly reader: VaultReader;
  private readonly ttlMs: number;
  private readonly now: () => number;

  private byPath: Map<string, NoteAdjacency> = new Map();
  private lastBuildAt = 0;
  private buildPromise: Promise<void> | null = null;

  constructor(opts: WikilinkGraphIndexOptions) {
    this.reader = opts.reader;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  async ensureFresh(): Promise<void> {
    if (this.buildPromise) {
      await this.buildPromise;
      return;
    }
    if (this.lastBuildAt > 0 && this.now() - this.lastBuildAt < this.ttlMs) {
      return;
    }
    this.buildPromise = this.rebuild()
      .then(() => {
        this.lastBuildAt = this.now();
      })
      .finally(() => {
        this.buildPromise = null;
      });
    await this.buildPromise;
  }

  getNoteLinks(notePath: string): NoteLinks {
    const entry = this.byPath.get(notePath);
    if (!entry) return { incoming: [], outgoing: [] };
    return {
      incoming: entry.incoming.map((e) => ({ ...e })),
      outgoing: entry.outgoing.map((e) => ({ ...e })),
    };
  }

  getBacklinkCount(notePath: string): number {
    return this.byPath.get(notePath)?.incoming.length ?? 0;
  }

  private async rebuild(): Promise<void> {
    const paths = await this.reader.scan();
    const basenameIndex = buildBasenameIndex(paths);

    const next = new Map<string, NoteAdjacency>();
    for (const p of paths) {
      next.set(p, { outgoing: [], incoming: [] });
    }

    for (let i = 0; i < paths.length; i += READ_BATCH_SIZE) {
      const slice = paths.slice(i, i + READ_BATCH_SIZE);
      const items = await this.reader.readNotes({
        paths: slice,
        fields: ['frontmatter', 'content'],
      });
      for (const item of items) {
        if ('error' in item) {
          if (item.error.code === 'READ_FAILED') {
            process.stderr.write(`[neuro-vault] wikilink-graph: ${item.error.message}\n`);
          }
          continue;
        }
        const adjacency = next.get(item.path);
        if (!adjacency) continue;
        const outgoing = collectOutgoing({
          notePath: item.path,
          body: item.content,
          frontmatter: item.frontmatter,
          basenameIndex,
        });
        adjacency.outgoing = outgoing;
        for (const edge of outgoing) {
          if (!edge.resolved || !edge.path) continue;
          const target = next.get(edge.path);
          if (!target) continue;
          target.incoming.push({ source: item.path });
        }
      }
    }

    this.byPath = next;
  }
}

function collectOutgoing(args: {
  notePath: string;
  body: string;
  frontmatter: Record<string, unknown> | null;
  basenameIndex: BasenameIndex;
}): OutgoingLink[] {
  const { notePath, body, frontmatter, basenameIndex } = args;
  const rawTargets = [
    ...parseWikilinks(body),
    ...(frontmatter ? extractWikilinksFromFrontmatter(frontmatter) : []),
  ];

  const seenResolved = new Set<string>();
  const seenUnresolved = new Set<string>();
  const out: OutgoingLink[] = [];

  for (const raw of rawTargets) {
    const target = normalizeWikilinkTarget(raw);
    if (!target) continue;
    const resolved = basenameIndex.resolve(target);
    if (resolved) {
      if (resolved === notePath) continue;
      if (seenResolved.has(resolved)) continue;
      seenResolved.add(resolved);
      out.push({ target, resolved: true, path: resolved });
    } else {
      if (seenUnresolved.has(target)) continue;
      seenUnresolved.add(target);
      out.push({ target, resolved: false });
    }
  }

  return out;
}
