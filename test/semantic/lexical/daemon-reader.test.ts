import { describe, expect, it, vi } from 'vitest';

import { DaemonRpcError, type LexicalSearchResult } from '../../../src/daemon/protocol.js';
import type { ILexicalReader, ILexicalResult } from '../../../src/lib/obsidian/lexical/reader.js';
import { LexicalSearchError } from '../../../src/lib/obsidian/lexical/reader.js';
import { createDaemonAttachment } from '../../../src/modules/semantic/backend/attachment.js';
import {
  DaemonConnectionError,
  DaemonTimeoutError,
  type IDaemonLink,
} from '../../../src/modules/semantic/daemon-connection.js';
import {
  createDaemonLexicalReader,
  LEXICAL_TIMEOUT_MS,
} from '../../../src/modules/semantic/lexical/index.js';
import {
  SharedServicesClosedError,
  type ISharedServices,
} from '../../../src/modules/semantic/shared-services.js';

const VAULT = '/vaults/notes';
const REAL = '/private/vaults/notes';
const SEARCH = { queries: ['alpha', 'beta'], noteCap: 10, perNoteCap: 3 };

const WIRE: LexicalSearchResult = {
  notes: [
    {
      path: 'a.md',
      matches: [{ matched_in: 'body', snippet: 'alpha here', lines: [3, 3] }],
      matched_queries: ['alpha'],
    },
  ],
  truncated: true,
  per_query_counts: { alpha: 1, beta: 0 },
  per_query_token_counts: { alpha: { alpha: 1 }, beta: { beta: 0 } },
  total_notes: 7,
};

const MAPPED: ILexicalResult = {
  notes: [
    {
      path: 'a.md',
      matches: [{ matched_in: 'body', snippet: 'alpha here', lines: [3, 3] }],
      matchedQueries: ['alpha'],
    },
  ],
  truncated: true,
  perQueryCounts: { alpha: 1, beta: 0 },
  perQueryTokenCounts: { alpha: { alpha: 1 }, beta: { beta: 0 } },
  totalNotes: 7,
};

type Handler = (params: Record<string, unknown>) => unknown;

function fakeServices(handlers: Record<string, Handler> = {}) {
  const defaults: Record<string, Handler> = {
    'vault.attach': () => ({ vault: REAL, profiles: {} }),
    'lexical.search': () => WIRE,
  };
  const link = {
    epoch: 1,
    ensure: vi.fn(async () => {}),
    close: vi.fn(),
    request: vi.fn(async (method: string, params: Record<string, unknown>, _timeoutMs: number) => {
      const handler = handlers[method] ?? defaults[method];
      if (handler === undefined) throw new Error(`unexpected ${method}`);
      return handler(params);
    }),
  };
  const services = {
    mode: 'daemon' as ISharedServices['mode'],
    connection: link as unknown as IDaemonLink,
    ensure: vi.fn(async () =>
      services.mode === 'local' ? ('local' as const) : ('daemon' as const),
    ),
    close: vi.fn(),
  };
  return { services, link };
}

function fakeLocal(): ILexicalReader {
  return {
    search: vi.fn(async () => MAPPED),
    warm: vi.fn(async () => {}),
  };
}

function readerOver(services: ISharedServices, local: () => ILexicalReader = fakeLocal) {
  const attachment = createDaemonAttachment({ services, vaultRoot: VAULT, profiles: [] });
  return { reader: createDaemonLexicalReader({ services, attachment, local }), attachment };
}

function methods(link: { request: { mock: { calls: unknown[][] } } }): string[] {
  return link.request.mock.calls.map(([method]) => method as string);
}

describe('createDaemonLexicalReader', () => {
  it('sends snake_case params and maps the result', async () => {
    const { services, link } = fakeServices();

    const result = await readerOver(services).reader.search(SEARCH);

    expect(result).toEqual(MAPPED);
    expect(methods(link)).toEqual(['vault.attach', 'lexical.search']);
    expect(link.request.mock.calls[1]).toEqual([
      'lexical.search',
      { vault: REAL, queries: ['alpha', 'beta'], note_cap: 10, per_note_cap: 3 },
      LEXICAL_TIMEOUT_MS,
    ]);
    expect(LEXICAL_TIMEOUT_MS).toBe(30_000);
  });

  it('allowed is sent only when given', async () => {
    const { services, link } = fakeServices();
    const { reader } = readerOver(services);

    await reader.search(SEARCH);
    await reader.search({ ...SEARCH, allowed: new Set(['a.md']) });
    await reader.search({ ...SEARCH, allowed: new Set() });

    const params = link.request.mock.calls
      .filter(([method]) => method === 'lexical.search')
      .map(([, p]) => p);
    expect('allowed' in params[0]).toBe(false);
    expect(params[1].allowed).toEqual(['a.md']);
    expect(params[2].allowed).toEqual([]);
  });

  it("LEXICAL_FAILED is a LexicalSearchError with the daemon's message", async () => {
    const cause = new DaemonRpcError('LEXICAL_FAILED', 'index exploded');
    const { services } = fakeServices({
      'lexical.search': () => {
        throw cause;
      },
    });

    const error = await readerOver(services)
      .reader.search(SEARCH)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LexicalSearchError);
    expect((error as LexicalSearchError).message).toContain('index exploded');
    expect((error as LexicalSearchError).cause).toBe(cause);
  });

  it('a vault the daemon cannot attach is a LexicalSearchError', async () => {
    const { services } = fakeServices({
      'vault.attach': () => {
        throw new DaemonRpcError('VAULT_UNAVAILABLE', 'no such vault');
      },
    });

    const error = await readerOver(services)
      .reader.search(SEARCH)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LexicalSearchError);
    expect((error as LexicalSearchError).message).toContain('no such vault');
  });

  it('a timeout fails the call and leaves services.mode daemon', async () => {
    const { services } = fakeServices({
      'lexical.search': () => {
        throw new DaemonTimeoutError('lexical.search timed out');
      },
    });

    const error = await readerOver(services)
      .reader.search(SEARCH)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LexicalSearchError);
    expect((error as LexicalSearchError).message).toContain('daemon did not answer');
    expect(services.mode).toBe('daemon');
  });

  it('a dropped connection and closed services are LexicalSearchErrors', async () => {
    for (const failure of [
      new DaemonConnectionError('connection dropped'),
      new SharedServicesClosedError(),
    ]) {
      const { services } = fakeServices({
        'lexical.search': () => {
          throw failure;
        },
      });

      const error = await readerOver(services)
        .reader.search(SEARCH)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LexicalSearchError);
      expect((error as LexicalSearchError).cause).toBe(failure);
      expect(services.mode).toBe('daemon');
    }
  });

  it('any other daemon error is a LexicalSearchError too', async () => {
    const { services } = fakeServices({
      'lexical.search': () => {
        throw new DaemonRpcError('INVALID_PARAMS', 'bad params');
      },
    });

    const error = await readerOver(services)
      .reader.search(SEARCH)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LexicalSearchError);
  });

  it('an answer without a notes array is a LexicalSearchError', async () => {
    const { services } = fakeServices({ 'lexical.search': () => ({ truncated: false }) });

    const error = await readerOver(services)
      .reader.search(SEARCH)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LexicalSearchError);
  });

  it('NOT_ATTACHED forgets the attach', async () => {
    let calls = 0;
    const { services, link } = fakeServices({
      'lexical.search': () => {
        calls += 1;
        if (calls === 1) throw new DaemonRpcError('NOT_ATTACHED', 'not attached');
        return WIRE;
      },
    });
    const { reader } = readerOver(services);

    const error = await reader.search(SEARCH).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LexicalSearchError);
    await expect(reader.search(SEARCH)).resolves.toEqual(MAPPED);

    expect(methods(link).filter((m) => m === 'vault.attach')).toHaveLength(2);
  });

  it('delegates to local once the switch is local', async () => {
    const { services, link } = fakeServices();
    services.mode = 'local';
    const local = fakeLocal();
    const build = vi.fn(() => local);
    const { reader } = readerOver(services, build);

    expect(await reader.search(SEARCH)).toEqual(MAPPED);
    await reader.search(SEARCH);

    expect(build).toHaveBeenCalledTimes(1);
    expect(local.search).toHaveBeenCalledWith(SEARCH);
    expect(link.request).not.toHaveBeenCalled();
  });

  it('warm attaches and never rejects', async () => {
    const { services, link } = fakeServices();
    const { reader, attachment } = readerOver(services);

    await expect(reader.warm()).resolves.toBeUndefined();
    expect(attachment.attached).toBe(true);
    expect(methods(link)).toEqual(['vault.attach']);

    const failing = fakeServices({
      'vault.attach': () => {
        throw new DaemonRpcError('VAULT_UNAVAILABLE', 'no vault');
      },
    });
    await expect(readerOver(failing.services).reader.warm()).resolves.toBeUndefined();

    failing.services.ensure.mockRejectedValue(new SharedServicesClosedError());
    await expect(readerOver(failing.services).reader.warm()).resolves.toBeUndefined();
  });

  it('warm hands the attach to the in-process reader once the switch is local', async () => {
    const { services, link } = fakeServices();
    services.mode = 'local';
    const local = fakeLocal();
    const { reader } = readerOver(services, () => local);

    await reader.warm();

    expect(local.warm).toHaveBeenCalledTimes(1);
    expect(link.request).not.toHaveBeenCalled();
  });
});
