import { describe, expect, it, vi } from 'vitest';

import { DaemonRpcError, type LexicalSearchResult } from '../../../src/daemon/protocol.js';
import {
  LexicalSearchError,
  type ILexicalResult,
} from '../../../src/lib/obsidian/lexical/reader.js';
import {
  DaemonConnectionError,
  DaemonTimeoutError,
} from '../../../src/modules/semantic/daemon-connection.js';
import { createLexicalReaderView } from '../../../src/modules/semantic/lexical/index.js';
import { SharedServicesClosedError } from '../../../src/modules/semantic/shared-services.js';
import type { IVaultClient } from '../../../src/modules/semantic/vault-client/index.js';

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

/** A client whose `call` answers `answer` (or throws what it throws). */
function fakeClient(answer: () => unknown = () => WIRE) {
  const client = {
    call: vi.fn(async (_method: string, _params: Record<string, unknown>) => answer()),
    status: vi.fn(async () => ({ state: 'ready' as const })),
    warm: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  return { client, view: createLexicalReaderView(client as unknown as IVaultClient) };
}

function rejecting(error: unknown) {
  return fakeClient(() => {
    throw error;
  });
}

async function failureOf(view: ReturnType<typeof fakeClient>['view']): Promise<unknown> {
  return view.search(SEARCH).catch((e: unknown) => e);
}

describe('createLexicalReaderView', () => {
  it('sends snake_case params and maps the result', async () => {
    const { client, view } = fakeClient();

    expect(await view.search(SEARCH)).toEqual(MAPPED);

    expect(client.call).toHaveBeenCalledExactlyOnceWith('lexical.search', {
      queries: ['alpha', 'beta'],
      note_cap: 10,
      per_note_cap: 3,
    });
  });

  it('allowed is sent only when given', async () => {
    const { client, view } = fakeClient();

    await view.search(SEARCH);
    await view.search({ ...SEARCH, allowed: new Set(['a.md']) });
    await view.search({ ...SEARCH, allowed: new Set() });

    const params = client.call.mock.calls.map(([, p]) => p);
    expect('allowed' in params[0]).toBe(false);
    expect(params[1]?.allowed).toEqual(['a.md']);
    expect(params[2]?.allowed).toEqual([]);
  });

  it("LEXICAL_FAILED is a LexicalSearchError with the entry's message", async () => {
    const cause = new DaemonRpcError('LEXICAL_FAILED', 'index exploded');

    const error = await failureOf(rejecting(cause).view);

    expect(error).toBeInstanceOf(LexicalSearchError);
    expect((error as LexicalSearchError).message).toBe('lexical search failed: index exploded');
    expect((error as LexicalSearchError).cause).toBe(cause);
  });

  it('a vault that cannot be attached, and any other refusal, is a LexicalSearchError', async () => {
    for (const cause of [
      new DaemonRpcError('VAULT_UNAVAILABLE', 'no such vault'),
      new DaemonRpcError('INVALID_PARAMS', 'bad params'),
      new Error('vault "/v" could not attach: the daemon connection changed'),
    ]) {
      const error = await failureOf(rejecting(cause).view);

      expect(error).toBeInstanceOf(LexicalSearchError);
      expect((error as LexicalSearchError).message).toBe(`lexical search failed: ${cause.message}`);
      expect((error as LexicalSearchError).cause).toBe(cause);
    }
  });

  it('a timeout reads "daemon did not answer"', async () => {
    const cause = new DaemonTimeoutError('daemon request lexical.search timed out after 30000 ms');

    const error = await failureOf(rejecting(cause).view);

    expect(error).toBeInstanceOf(LexicalSearchError);
    expect((error as LexicalSearchError).message).toBe(
      'daemon did not answer lexical.search in time',
    );
    expect((error as LexicalSearchError).cause).toBe(cause);
  });

  it('a dropped connection and closed services are LexicalSearchErrors', async () => {
    const dropped = new DaemonConnectionError('connection dropped');
    const closed = new SharedServicesClosedError();

    const lost = await failureOf(rejecting(dropped).view);
    const gone = await failureOf(rejecting(closed).view);

    expect(lost).toBeInstanceOf(LexicalSearchError);
    expect((lost as LexicalSearchError).message).toBe(
      'daemon connection lost during lexical.search: connection dropped',
    );
    expect((lost as LexicalSearchError).cause).toBe(dropped);
    expect(gone).toBeInstanceOf(LexicalSearchError);
    expect((gone as LexicalSearchError).cause).toBe(closed);
  });

  it('an answer without a notes array is a LexicalSearchError', async () => {
    const error = await failureOf(fakeClient(() => ({ truncated: false })).view);

    expect(error).toBeInstanceOf(LexicalSearchError);
    expect((error as LexicalSearchError).message).toBe(
      'daemon answered lexical.search without a notes list',
    );
  });

  it('warm is the client warm-up', async () => {
    const { client, view } = fakeClient();

    await expect(view.warm()).resolves.toBeUndefined();

    expect(client.warm).toHaveBeenCalledTimes(1);
    expect(client.call).not.toHaveBeenCalled();
  });
});
