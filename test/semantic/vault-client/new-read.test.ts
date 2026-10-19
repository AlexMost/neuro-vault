/**
 * The cost claim of the vault client: a new per-vault read costs a method-table row, its service
 * handler (a params schema and the handler of the parsed params) and a three-line view — and
 * nothing in either vault-client adapter, the link, the attachment or the client factory.
 *
 * `probe.echo` below is such a read. Its row is added by declaration merging into `VaultMethods`,
 * so it lives in this test file (the typecheck covers `test/`) instead of widening the shipped
 * method table; if some exhaustive per-method record existed in `src/`, this file would stop
 * compiling. The same `probe` handlers and the same view then reach the entry over the daemon
 * socket and in-process, each after exactly one `vault.attach`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { z } from 'zod';

import {
  defineMethod,
  ServiceRegistry,
  type ServiceHandlers,
} from '../../../src/daemon/protocol.js';
import { createVaultEntryServices } from '../../../src/daemon/services/vault-entry-services.js';
import { startDaemonServer, type DaemonServerHandle } from '../../../src/daemon/socket-server.js';
import { VaultEntries } from '../../../src/lib/vault-entry/index.js';
import type { DaemonConnection } from '../../../src/modules/semantic/daemon-connection.js';
import {
  createAttachment,
  createDaemonVaultClient,
  createInProcessLink,
  createLinkedVaultClient,
  type IVaultClient,
} from '../../../src/modules/semantic/vault-client/index.js';
import { daemonServices } from '../../integration/_daemon-fixture.js';

const probeEchoParams = z.strictObject({ vault: z.string(), text: z.string() });

declare module '../../../src/daemon/protocol.js' {
  interface VaultMethods {
    'probe.echo': {
      params: z.infer<typeof probeEchoParams>;
      result: { vault: string; text: string };
    };
  }
}

const posix = process.platform !== 'win32';

/** The new read's handler: the service side of the row. */
const probe: ServiceHandlers = {
  echo: defineMethod({
    params: probeEchoParams,
    handler: async ({ vault, text }) => ({ vault, text }),
  }),
};

/** The new read's view: what a facade would add. */
const echo = (client: IVaultClient, text: string) => client.call('probe.echo', { text });

describe('a new per-vault read', () => {
  let dir: string;
  let vault: string;
  let entries: VaultEntries;
  let handle: DaemonServerHandle | undefined;
  let connection: DaemonConnection | undefined;
  let client: IVaultClient | undefined;

  beforeEach(() => {
    // Short enough for the 104-byte sun_path limit of macOS.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-nr-'));
    vault = path.join(dir, 'notes');
    fs.mkdirSync(vault);
    entries = new VaultEntries({
      // No profile is attached, so no model or corpus is ever needed.
      embedderFor: () => async () => [],
      idleTimeoutMs: 0,
      warn: () => {},
    });
  });

  afterEach(async () => {
    await client?.dispose();
    connection?.close();
    await handle?.close();
    await entries.dispose();
    client = undefined;
    connection = undefined;
    handle = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!posix)(
    'a new read reaches the entry through both adapters with no adapter change',
    async () => {
      const resolved = fs.realpathSync(vault);

      // Over the daemon socket: the registry the daemon registers, plus the new service.
      const registry = new ServiceRegistry();
      for (const [name, handlers] of Object.entries(createVaultEntryServices(entries))) {
        registry.register(name, handlers);
      }
      registry.register('probe', probe);
      const socketPath = path.join(dir, 's.sock');
      handle = await startDaemonServer({
        socketPath,
        registry,
        idleTimeoutMs: 0,
        onIdle: () => {},
      });
      const session = daemonServices({ dir, socketPath });
      connection = session.connection;
      client = createDaemonVaultClient({
        services: session.services,
        attachment: createAttachment({
          link: session.services.connection,
          vaultRoot: vault,
          profiles: [],
        }),
        local: () => {
          throw new Error('must not fall back: the daemon is listening');
        },
      });

      expect(await echo(client, 'hi')).toEqual({ vault: resolved, text: 'hi' });
      expect(session.sent.filter((method) => method === 'vault.attach')).toHaveLength(1);
      expect(session.sent.indexOf('vault.attach')).toBeLessThan(session.sent.indexOf('probe.echo'));
      await client.dispose();
      client = undefined;

      // In-process: the same map of services over the loopback.
      const services: Record<string, ServiceHandlers> = {
        ...createVaultEntryServices(entries),
        probe,
      };
      const attachHandler = services.vault.attach;
      let attaches = 0;
      services.vault = {
        ...services.vault,
        attach: (params, ctx) => {
          attaches++;
          return attachHandler(params, ctx);
        },
      };
      const link = createInProcessLink(services);
      client = createLinkedVaultClient({
        link,
        attachment: createAttachment({ link, vaultRoot: vault, profiles: [] }),
      });

      expect(await echo(client, 'hi')).toEqual({ vault: resolved, text: 'hi' });
      expect(attaches).toBe(1);
      link.close();
    },
  );
});
