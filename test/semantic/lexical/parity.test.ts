import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ServiceRegistry } from '../../../src/daemon/protocol.js';
import { createVaultEntryServices } from '../../../src/daemon/services/vault-entry-services.js';
import { startDaemonServer, type DaemonServerHandle } from '../../../src/daemon/socket-server.js';
import type { ILexicalReader } from '../../../src/lib/obsidian/lexical/reader.js';
import { FsVaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import { WikilinkGraphIndex } from '../../../src/lib/obsidian/wikilink-graph.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { VaultEntries } from '../../../src/lib/vault-entry/index.js';
import { createVaultEntry } from '../../../src/lib/vault-entry/vault-entry.js';
import { createDisabledSemanticBackend } from '../../../src/modules/semantic/backend/index.js';
import {
  createLexicalReaderView,
  createStandaloneLexicalReader,
} from '../../../src/modules/semantic/lexical/index.js';
import {
  buildSearchNotesTool,
  type SearchNotesOutput,
} from '../../../src/modules/semantic/tools/search-notes.js';
import {
  createAttachment,
  createDaemonVaultClient,
  createInProcessLink,
  createLinkedVaultClient,
  type IInProcessLink,
} from '../../../src/modules/semantic/vault-client/index.js';
import { callTool } from '../../_gate.js';
import { TEST_SIMILARITY } from '../../_identity.js';
import { daemonServices } from '../../integration/_daemon-fixture.js';
import {
  FIXTURE_PATHS,
  QUERY_SETS,
  writeFixtureVault,
} from '../../lib/obsidian/lexical/_fixture-vault.js';
import { LegacyLexicalIndex } from '../../lib/obsidian/lexical/_legacy-lexical-index.js';
import { makeTestRegistry } from '../../operations/tools/_test-registry.js';
import { createGraphReader } from '../../../src/lib/obsidian/graph-reader.js';

const posix = process.platform !== 'win32';
const CAPS = { noteCap: 10, perNoteCap: 3 };
const DEBOUNCE_MS = 100;

/** `[label, allowed]` for the two scopes every reader is asked under. */
const FILTERS: Array<[string, Set<string> | undefined]> = [
  ['no filter', undefined],
  ['5 allowed paths', new Set(FIXTURE_PATHS.slice(0, 5))],
];

/**
 * The three readers over one fixture vault, as a session builds them: the standalone one over the
 * session's reader and graph, and the lexical view over the vault's two clients — the in-process
 * one over a loopback on in-process vault entries, and the daemon one over a real socket server
 * with the vault entry's services. `[]` profiles throughout: the lexical leg needs no corpus, so
 * no model is loaded and nothing is embedded.
 */
describe.skipIf(!posix)('the three lexical readers give one answer', () => {
  let dir: string;
  let vaultRoot: string;
  let socketPath: string;
  let handle: DaemonServerHandle | undefined;
  let daemonEntries: VaultEntries | undefined;
  let localEntries: VaultEntries | undefined;
  let loopback: IInProcessLink | undefined;
  let closers: Array<() => void>;
  let reader: FsVaultReader;
  let graph: WikilinkGraphIndex;
  let readers: Record<'standalone' | 'local' | 'daemon', ILexicalReader>;

  const newEntries = () =>
    new VaultEntries({
      embedderFor: () => async (texts) => texts.map(() => []),
      idleTimeoutMs: 0,
      createEntry: (opts) => createVaultEntry({ ...opts, debounceMs: DEBOUNCE_MS }),
      warn: () => {},
    });

  beforeEach(async () => {
    // Short enough for the 104-byte sun_path limit of macOS.
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-lp-'));
    vaultRoot = path.join(dir, 'vault');
    socketPath = path.join(dir, 's.sock');
    await writeFixtureVault(vaultRoot);
    closers = [];
    reader = new FsVaultReader({ vaultRoot });
    graph = new WikilinkGraphIndex({ reader });

    daemonEntries = newEntries();
    const registry = new ServiceRegistry();
    for (const [name, handlers] of Object.entries(createVaultEntryServices(daemonEntries))) {
      registry.register(name, handlers);
    }
    handle = await startDaemonServer({ socketPath, registry, idleTimeoutMs: 0, onIdle: () => {} });
    const { services } = daemonServices({ dir, socketPath });
    closers.push(() => services.close());

    localEntries = newEntries();
    loopback = createInProcessLink(createVaultEntryServices(localEntries));
    const link = loopback;

    readers = {
      standalone: createStandaloneLexicalReader({ vaultRoot, reader, graph }),
      local: createLexicalReaderView(
        createLinkedVaultClient({
          link,
          attachment: createAttachment({ link, vaultRoot, profiles: [] }),
        }),
      ),
      daemon: createLexicalReaderView(
        createDaemonVaultClient({
          services,
          attachment: createAttachment({ link: services.connection, vaultRoot, profiles: [] }),
          local: () => {
            throw new Error('must not fall back: the daemon is listening');
          },
        }),
      ),
    };
  });

  afterEach(async () => {
    for (const close of closers) close();
    loopback?.close();
    loopback = undefined;
    await handle?.close();
    await daemonEntries?.dispose();
    await localEntries?.dispose();
    handle = undefined;
    daemonEntries = undefined;
    localEntries = undefined;
    await fs.rm(dir, { recursive: true, force: true });
  });

  for (const [label, allowed] of FILTERS) {
    for (const queries of QUERY_SETS) {
      it(`${label}: ${JSON.stringify(queries)}`, { timeout: 15_000 }, async () => {
        await graph.ensureFresh();
        const expected = await new LegacyLexicalIndex({ vaultRoot, reader }).search({
          queries,
          ...(allowed ? { allowed } : {}),
          ...CAPS,
          getBacklinkCount: (p) => graph.getBacklinkCount(p),
        });
        const search = { queries, ...(allowed ? { allowed } : {}), ...CAPS };

        expect(await readers.standalone.search(search), 'standalone').toEqual(expected);
        expect(await readers.local.search(search), 'local').toEqual(expected);
        expect(await readers.daemon.search(search), 'daemon').toEqual(expected);
      });
    }
  }

  describe('search_notes', () => {
    /** The same tool over the same vault; only the registry entry's `lexical` differs. */
    function toolWith(lexical: ILexicalReader, backend: 'absent' | 'disabled') {
      const registry = makeTestRegistry([
        {
          name: 'v',
          path: vaultRoot,
          reader,
          graph: createGraphReader(() => graph),
          lexical,
          ...(backend === 'disabled' ? { backend: createDisabledSemanticBackend() } : {}),
        },
      ]);
      return registerTool(
        buildSearchNotesTool({
          registry,
          embeddingProvider: {
            initialize: async () => {},
            embedQuery: () => Promise.reject(new Error('the semantic leg must not run')),
          },
          modelKey: 'k',
          similarity: TEST_SIMILARITY,
        }),
      );
    }

    const variants: Array<[string, 'lexical' | 'hybrid', 'absent' | 'disabled']> = [
      ['lexical mode, no backend', 'lexical', 'absent'],
      ['lexical mode, backend disabled', 'lexical', 'disabled'],
      ['hybrid mode, backend disabled', 'hybrid', 'disabled'],
      ['hybrid mode, no backend', 'hybrid', 'absent'],
    ];

    for (const [label, mode, backend] of variants) {
      it(`one payload for the three registry entries: ${label}`, { timeout: 20_000 }, async () => {
        const tools = {
          standalone: toolWith(readers.standalone, backend),
          local: toolWith(readers.local, backend),
          daemon: toolWith(readers.daemon, backend),
        };
        for (const queries of QUERY_SETS) {
          const input = { query: queries.length === 1 ? queries[0] : queries, mode };
          const expected = await callTool<SearchNotesOutput>(tools.standalone, input);
          const where = JSON.stringify(queries);

          expect(await callTool<SearchNotesOutput>(tools.local, input), `local ${where}`).toEqual(
            expected,
          );
          expect(await callTool<SearchNotesOutput>(tools.daemon, input), `daemon ${where}`).toEqual(
            expected,
          );
        }
      });
    }

    it('the sets return matches (the comparison is not of empty payloads)', async () => {
      const out = await callTool<SearchNotesOutput>(toolWith(readers.daemon, 'disabled'), {
        query: ['пошук', 'release'],
        mode: 'lexical',
      });
      expect(out.matches.length).toBeGreaterThan(0);
    });
  });
});
