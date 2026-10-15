# Wire payload limits of the daemon socket (October 2026)

Research for [issue #163](https://github.com/AlexMost/neuro-vault/issues/163), a ticket of the wayfinder map [#160](https://github.com/AlexMost/neuro-vault/issues/160): what the daemon's wire can carry, and how big the messages `corpus.*` and `lexical.*` will put on it. The wire is newline-delimited JSON-RPC 2.0 framed by the MCP SDK's stdio `ReadBuffer` / `serializeMessage` ([`shared-daemon.md` § Protocol](../architecture/shared-daemon.md#protocol)), carried over a unix socket by `src/daemon/socket-server.ts` (server) and `src/modules/semantic/daemon-connection.ts` (client).

Findings are as of 2026-10-15. Measurements were taken on one machine (Apple M5, macOS 25.6, Node v24.13.0) with throwaway scripts in the session scratchpad; treat them as indicative. Every path in the size estimates is synthetic.

## TL;DR

- **The installed SDK (`@modelcontextprotocol/sdk` 1.29.0) imposes no limit at all.** `ReadBuffer.append` is `Buffer.concat`, `readMessage` splits on `\n`, `serializeMessage` is `JSON.stringify(message) + '\n'`. Neither the daemon server nor the client adds one. The only hard ceilings are V8's: a line must fit one string (`buffer.constants.MAX_STRING_LENGTH` = 536,870,888 chars, ~512 MiB).
- **Upstream added a 10 MiB cap in 1.30.0** (2026-07-27, PR #2239 "v1 stdio buffer limit"): `new ReadBuffer({ maxBufferSize })` defaults to `STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024`, and `append` **throws** once the pending bytes exceed it. Our `package.json` range is `^1.15.1`, so the next `npm update` pulls the cap in. Both of our `'data'` handlers call `buffer.append(chunk)` *outside* their `try`, and neither process installs an `uncaughtException` handler, so a > 10 MiB message would crash the daemon (server side) or the session (client side) instead of failing one request. Nothing planned comes near 10 MiB (below), but the `append` call should move inside the `try` before the dependency moves.
- **Planned messages are small.** `allowed` for ~1,000 notes is **44–69 KiB** per request (ASCII vs. Cyrillic file names), 0.03–0.06 ms to stringify or parse; ~440 KiB at 10,000 notes. A deep semantic leg result is **5–11 KiB**, a deep lexical leg result **6–9 KiB**. The biggest message the wire carries *today* is `embed.documents` for 8 texts: **99 KiB** at 640 dims, **158 KiB** at 1,024 dims. The new messages are at most half of what already flows.
- **The one real cost is quadratic buffering, and it is negligible at these sizes.** The unix socket delivers 8 KiB chunks on macOS, and `ReadBuffer.append` re-copies the whole pending buffer per chunk: a 440 KiB line costs ~12 MiB of copying and 2 ms; a 4 MiB line would cost ~1 GiB and 160 ms. Below 1 MiB per message the framing is free; a design that wanted multi-MiB messages should length-prefix instead (what Nx did).
- **Peers:** Nx length-prefixes with a 2 GiB default cap after a string-length crash (`RangeError: Invalid string length`); Watchman's JSON line protocol and BSER PDUs have no cap and grow the buffer by doubling; pm2's AMP frames are per-argument 32-bit length-prefixed with no cap. None chunks a message at the application level.

## 1. What the framing allows

### The installed SDK

`node_modules/@modelcontextprotocol/sdk/package.json` → `"version": "1.29.0"`. `dist/esm/shared/stdio.js` in full:

```js
export class ReadBuffer {
    append(chunk) {
        this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;
    }
    readMessage() {
        if (!this._buffer) {
            return null;
        }
        const index = this._buffer.indexOf('\n');
        if (index === -1) {
            return null;
        }
        const line = this._buffer.toString('utf8', 0, index).replace(/\r$/, '');
        this._buffer = this._buffer.subarray(index + 1);
        return deserializeMessage(line);
    }
    clear() {
        this._buffer = undefined;
    }
}
export function deserializeMessage(line) {
    return JSONRPCMessageSchema.parse(JSON.parse(line));
}
export function serializeMessage(message) {
    return JSON.stringify(message) + '\n';
}
```

No maximum line length, no maximum pending-buffer size, no timeout on an incomplete line. A peer that never sends `\n` grows `_buffer` until allocation fails. The same code is in the upstream tag ([`src/shared/stdio.ts` at v1.29.0](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/src/shared/stdio.ts)).

The server transport (`dist/esm/server/stdio.js`) calls `this._readBuffer.append(chunk)` and loops `readMessage()` with a `try` around the loop only; `send` writes `serializeMessage(message)` and waits for `'drain'` when `write` returns `false`. The MCP spec's only framing rule is "Messages are delimited by newlines, and MUST NOT contain embedded newlines" ([transports, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#stdio)); it states no size limit, and custom transports "MUST ensure they preserve the JSON-RPC message format".

### What this repo adds

Nothing. `src/daemon/socket-server.ts`:

```ts
const buffer = new ReadBuffer();
socket.on('data', (chunk: Buffer) => {
  buffer.append(chunk);
  for (;;) {
    let message: JSONRPCMessage | null;
    try {
      message = buffer.readMessage();
    } catch {
      socket.destroy();
      return;
    }
    ...
```

and `write` is `socket.write(serializeMessage(message))` with no backpressure handling (a response is queued in user memory however large it is; see § 4). `src/modules/semantic/daemon-connection.ts` `attach()` is the mirror image: `buffer.append(chunk)` outside the `try`, `readMessage()` inside, a framing error drops the connection and rejects every pending request. `src/daemon/protocol.ts` validates params per method (`embed.documents` rejects `texts.length > max_batch_size`) but never looks at byte sizes.

### Upstream has since added a cap

The 1.30.0 release notes (2026-07-27) list "v1 stdio buffer limit by @KKonstantinov in [#2239](https://github.com/modelcontextprotocol/typescript-sdk/pull/2239)" (merged 2026-06-02). [`src/shared/stdio.ts` at 1.30.0](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.30.0/src/shared/stdio.ts):

```ts
export const STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024;

export class ReadBuffer {
    private _buffer?: Buffer;
    private _maxBufferSize: number;

    constructor(options?: { maxBufferSize?: number }) {
        this._maxBufferSize = options?.maxBufferSize ?? STDIO_DEFAULT_MAX_BUFFER_SIZE;
    }

    append(chunk: Buffer): void {
        const newSize = (this._buffer?.length ?? 0) + chunk.length;
        if (newSize > this._maxBufferSize) {
            this.clear();
            throw new Error(`ReadBuffer exceeded maximum size of ${this._maxBufferSize} bytes`);
        }
        this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;
    }
```

The v2 line (`packages/core-internal/src/shared/stdio.ts` on `main`) keeps the same constant and constructor, exposes it as `maxBufferSize` on both stdio transports ("Defaults to 10 MB"; on overflow they call `onerror` and then `close()`), and additionally skips non-JSON lines (`SyntaxError` → `continue`) rather than throwing. The cap is on the *pending* buffer, i.e. effectively on one line, since complete lines are consumed as they arrive. The `Buffer.concat`-per-chunk pattern was not changed: upstream issue [#2961](https://github.com/modelcontextprotocol/typescript-sdk/issues/2961) ("reading a single large stdio message takes time quadratic in its size": 5 MB 0.1 s, 25 MB 1.9 s, 100 MB 38 s) and [#2536](https://github.com/modelcontextprotocol/typescript-sdk/issues/2536) (an empty `subarray` keeps the old backing store alive) are open with fix PRs, and [PR #2793](https://github.com/modelcontextprotocol/typescript-sdk/pull/2793) notes that after an overflow the buffer resyncs mid-message, so the tail of the rejected line can be parsed as a new line. The GitHub advisory the sibling SDKs cite for this (`GHSA-wqgc-pwpr-pq7r`) was not retrievable; the Kotlin (CVE-2026-53937) and Ruby (CVE-2026-63119) advisories describe the same bug: a peer that streams bytes without a newline exhausts memory.

**Consequence for this repo.** `"@modelcontextprotocol/sdk": "^1.15.1"` resolves 1.30.x–1.32.x on the next lockfile refresh. Then `new ReadBuffer()` in both our files silently carries a 10 MiB cap, and an overflow throws from `append`, which sits before the `try` in both handlers. An exception thrown from a `'data'` listener is an uncaught exception; `src/cli-daemon.ts`, `src/cli.ts` and `src/daemon/*.ts` register no `uncaughtException` handler (grep, 2026-10-15). So one oversized line would take the daemon down for every session (server side) or the session itself (client side). Two cheap fixes, either of which is enough: move `append` inside the `try` (destroy / drop the connection, which is what we do for a malformed line), and pass an explicit `maxBufferSize` so the cap is a decision of ours rather than a dependency's default. Nothing in this map needs more than ~0.5 MiB (next section), so 10 MiB is a fine number to adopt deliberately.

## 2. How big the planned messages are

Shapes are read from the code; bytes are `Buffer.byteLength(serializeMessage(msg))` of a filled-in JSON-RPC line. The `queries` strings are ~45 chars each.

### The `allowed` path list

The session keeps the filter and sends the `allowed` set with the query (map decision). `search_notes` computes it with `listMatchingPaths(input.filter)` (`src/modules/semantic/tools/search-notes.ts`) and today passes it as a `Set<string>` into `runRetrievalPipeline`, where the semantic leg narrows the snapshot and the lexical leg filters `reader.scan()` by it. Over the wire it becomes a JSON array of vault-relative paths; both legs need it, so a request that hits both `corpus.*` and `lexical.*` sends it twice unless the two are one call.

| Notes | Average path | JSON array | Full request line | `JSON.stringify` | `JSON.parse` |
| --- | --- | --- | --- | --- | --- |
| 1,000, ASCII names (`Areas/Work/planning-daemon-notes-0042.md`) | 41.6 B | 43.6 KiB | 43.7 KiB | 0.03 ms | 0.03 ms |
| 1,000, Cyrillic names (+14 chars, 2 B each) | 67.6 B | 68.9 KiB | 69.1 KiB | 0.06 ms | 0.06 ms |
| 10,000, ASCII names | 41.6 B | 435.5 KiB | 435.7 KiB | 0.37 ms | 0.30 ms |

Spreading a `Set` into an array before stringifying adds nothing measurable (0.03 ms at 1,000). JSON does not escape non-ASCII, so Cyrillic costs its UTF-8 width and no more. The per-request cost is therefore the bytes themselves (44–69 KiB for the issue's ~1,000-note vault, under 0.1 ms each side) plus one `Buffer.concat` pass per 8 KiB chunk received (§ 4): ~0.9 ms for 44 KiB when it arrives in 6 chunks. A vault of 10,000 notes with a wide filter is 0.44 MiB per request, still under 3 ms end to end.

A wide filter on a large vault is the only shape that scales with the vault rather than with the effort profile, so it is the one to keep an eye on; the cheap future options are to send the filter instead of its result (out of scope for this map, which keeps filters in the session), or to send `excluded` when the filter keeps most of the vault.

### Semantic leg result (deep)

`executeRetrieval` (`src/modules/semantic/retrieval-policy.ts`) returns `{ results: NoteResultNode[], truncated, per_query_hits, per_query_fallback }`. At `deep` (`src/modules/semantic/effort-profiles.ts`: `semanticPool: 8`, `expansion: true`, `expansionLimit: 3`; thresholds from the model profile):

- 8 seeds, each `{ path, similarity, matched_queries: string[], blocks: BlockMatch[], related: RelatedNote[] }`;
- blocks: `findBlockNeighbors` is called once per query with `limit = 8` over the seed notes, merged by `(path, heading, lines)` keeping the max similarity, plus a backfill of one best block per seed that got none — so at most `8 × queries + 8` blocks, each `{ heading, lines: [a, b], similarity }`;
- related: 3 per seed, `{ path, expansion_similarity }`, 24 in total;
- a float prints as ~18–20 characters (`0.6123456789012345`).

| Queries | Names | Line size |
| --- | --- | --- |
| 1 | ASCII | 4.7 KiB (4,817 B) |
| 1 | Cyrillic paths and headings | 5.8 KiB (5,905 B) |
| 5 | Cyrillic | 10.7 KiB (10,925 B), 40 blocks |

The `quick` profile is smaller (3 seeds, 5 blocks per query, no expansion). If `corpus.*` returned per-note vectors instead of scores it would be a different story (640 floats × ~20 chars = 12.4 KiB per vector), but the map's decision is that the daemon serves legs and the session fuses, so vectors never cross the wire in a query.

### Lexical leg result (deep)

`LexicalIndex.search` (`src/lib/obsidian/lexical/lexical-index.ts`) returns `rankNotes`'s `{ notes: RankedNote[], truncated, perQueryCounts, perQueryTokenCounts }` plus `totalNotes`. At `deep`: `noteCap: 10`, `perNoteCap: LEXICAL_PER_NOTE_CAP = 3`. Each `RankedNote` is `{ path, matches: LexicalMatch[], matchedQueries }`, each match `{ matched_in, snippet, lines?, heading? }`. The snippet is bounded by `makeSnippet` (`snippet.ts`): the raw unit if ≤ 150 chars, else a ~150-grapheme window with `…` on each side; a heading match repeats the heading text, a title match the file name. `perQueryTokenCounts` is filled only for a multi-token query that matched nothing — a handful of `token: count` entries.

| Queries | Text | Line size |
| --- | --- | --- |
| 1 | ASCII snippets | 5.6 KiB (5,761 B) |
| 1 | Cyrillic snippets (2 B per char) | 8.0 KiB (8,191 B) |
| 5 | Cyrillic | 8.7 KiB (8,903 B) |

Worst case is 30 body snippets of 150 graphemes in a 4-byte script (~18 KiB); a grapheme can be a multi-codepoint emoji sequence, which is the only way past that, and an unlikely one in a note body.

### What the wire carries today, for scale

`embed.query` returns one vector, `embed.documents` up to `max_batch_size` (`LOCAL_MAX_BATCH_SIZE = 8`) vectors, as `number[]` — a `Float32` printed through `JSON.stringify` averages 19.8 characters.

| Profile dims | `embed.query` result | `embed.documents` (8 texts) result |
| --- | --- | --- |
| 384 | 7.5 KiB | 59.3 KiB |
| 640 (default, `harrier-270m`) | 12.4 KiB | 98.9 KiB |
| 1,024 | 19.8 KiB | 158.2 KiB |

So an indexing session already pushes ~100–160 KiB responses through this framing on every batch; a 1,000-note `allowed` list is smaller than one of them, and the leg results are an order of magnitude smaller.

## 3. How Nx, Watchman and pm2 handle large messages

All three speak one message per connection turn over a unix socket; none chunks a message at the application level. Summary (sources follow):

| CLI | Framing | Cap | Chunking |
| --- | --- | --- | --- |
| Nx daemon ≥ 23.2.0 | length prefix `NX_MSG_<bytes>:` + raw payload (JSON or v8-serialized) | 2 GiB default, `NX_MAX_MESSAGE_SIZE` (0 = none), checked when the header is parsed | none; header and payload are two `socket.write`s, reader reassembles OS chunks |
| Nx daemon ≤ 23.1.x | trailing marker (`NX_MSG_END` + U+0004; earlier a bare U+0004) on a string | implicit ~512 MiB from V8's max string length | none; whole message accumulated as a string |
| Watchman | JSON: one line + `\n`; BSER: PDU length-prefixed (encoded integer) | none; server buffer `realloc`s ×2 until OOM; BSER container ≤ `uint32::max`, depth ≤ 500 | none |
| pm2 (`pm2-axon` + `amp`) | AMP: 1 byte `ver<<4\|argc`, then per-argument 4-byte big-endian length + bytes | none; 4 GiB per argument from the field width | none; `amp` stream parser reassembles |

**Nx** replaced its delimiter framing on 2026-08-31 ([PR #36838](https://github.com/nrwl/nx/pull/36838), "fall back to v8 for oversized daemon responses and length-prefix the wire protocol", shipped in 23.2.0) after a large `HASH_TASKS` response killed the daemon with `RangeError: Invalid string length`; the PR notes that delimiter framing on latin1 strings "capped every message at Node's max string length of 536,870,888 characters in three places". The current reader ([`consume-messages-from-socket.ts`](https://github.com/nrwl/nx/blob/master/packages/nx/src/utils/consume-messages-from-socket.ts)) keeps a `Buffer[]` list and copies only when a message spans chunks; the cap comment reads: "Payloads are buffered outside the V8 heap, so `--max-old-space-size` does not bound them and a peer that declares a huge length would otherwise be allowed to stream until the machine gives out. The default is four times the ~0.5GiB string ceiling that used to cap every message". `writeMessage` writes header and payload separately "so a large payload is never copied to prepend its header". Serialization ([`socket-utils.ts`](https://github.com/nrwl/nx/blob/master/packages/nx/src/daemon/socket-utils.ts)) tries v8 or JSON and falls back: "JSON cannot represent a BigInt and hits the max string length far sooner, while v8 cannot clone a function." The project-graph response is still built by string concatenation, so it keeps the ~512 MiB string ceiling before framing.

**Watchman**'s [socket interface](https://facebook.github.io/watchman/docs/socket-interface.html): "The JSON encoding represents a request or a response as a single line of compact JSON encoded data. The newline is used to detect the end of the PDU." BSER exists for "applications with higher performance requirements"; its [PDU](https://facebook.github.io/watchman/docs/bser.html) "is prefixed by its length expressed as an encoded integer. This allows the peer to determine how much storage is required to read and decode it." The server reader (`watchman/PDU.cpp`) starts at a 1 MiB buffer and doubles with `realloc` for both encodings, failing only when allocation fails; `watchman/bser.cpp` limits a container to `uint32::max` entries and nesting to 500. The Node client (`watchman/node/bser/index.js`) always speaks BSER, reads the declared PDU length and grows its accumulator to the next power of two; no cap.

**pm2** talks to its daemon through `pm2-axon` (`req` socket on `rpc.sock`) with `pm2-axon-rpc` on top, which sends `{ type: 'call', method, args }` as one JSON argument. Framing is tj's AMP ([Readme](https://github.com/tj/node-amp)): "The `version` and `argc` integers are stored in the first byte, followed by a sequence of zero or more `<length>` / `<data>` pairs, where `length` is a 32-bit unsigned integer." The [stream parser](https://github.com/tj/node-amp/blob/master/lib/stream.js) reads `readUInt32BE`, pushes slices and emits `Buffer.concat(this._bufs)` when all arguments arrived — no size check. [`pm2-axon/lib/sockets/sock.js`](https://github.com/Unitech/pm2-axon/blob/master/lib/sockets/sock.js) sets `hwm` to `Infinity` and pipes the socket into the parser. No upstream issue about socket payload size was found for any of the three; pm2's only "Invalid string length" report (#3925) is log-file accumulation, not the socket.

**What to take from it.** Newline framing is what Watchman ships to this day for its JSON mode and what the MCP spec mandates for stdio; it breaks down only when a single message approaches V8's string ceiling or when the reader copies on every chunk and messages reach many MiB — Nx's problem, with per-file hash data, three orders of magnitude above anything here. A cap is a DoS guard on an untrusted peer more than a capacity statement; both Nx (2 GiB) and the MCP SDK (10 MiB) chose a number far above their real traffic.

## 4. Node `net.Socket` facts that matter here

- **No limit on a `write`.** Node's `net` docs: "`net.Socket` has the property that `socket.write()` always works ... Node.js will internally queue up the data written to a socket and send it out over the wire when it is possible. The consequence of this internal buffering is that memory may grow." ([net.html](https://nodejs.org/api/net.html#socketbuffersize)). `write` returns `false` once `writableLength` passes `highWaterMark` — "a threshold, not a limit: it dictates the amount of data that a stream buffers before it stops asking for more data. It does not enforce a strict memory limitation" ([stream.html](https://nodejs.org/api/stream.html#buffering)). Measured: a 5 MB `write` to a unix socket returns `false` with `writableLength` 5,000,000 and is delivered in full. Our `write` helper ignores the return value; that is correct for responses of tens of KiB and only matters if the daemon ever streams.
- **`highWaterMark` is 64 KiB** for byte streams on non-Windows since Node 22 ("bump default highWaterMark", nodejs/node#52037; 16 KiB on Windows and on Node 20) — `stream.getDefaultHighWaterMark()` ([stream.html](https://nodejs.org/api/stream.html#streamgetdefaulthighwatermarkobjectmode)); `net.createServer({ highWaterMark })` overrides it for every socket since v20.1.0. Observed `writableHighWaterMark` and `readableHighWaterMark` on a `net.Socket` here: 65,536.
- **`'data'` chunks are whatever the kernel hands over.** The docs promise only "a `Buffer` or `String`" per `'data'` event. On this macOS machine a unix-socket write arrives in **8 KiB** chunks regardless of size (53 KB → 7 chunks, 530 KB → 65, 5 MB → 611; all delivered within 4 ms) — `sysctl net.local.stream.sendspace` / `recvspace` are 8192 here. Linux socket buffers are larger, so chunks there can be bigger, but a reader must assume any split, including inside a multi-byte character — which `ReadBuffer` handles by only decoding up to a `\n`.
- **`ReadBuffer.append` is quadratic in chunks.** `Buffer.concat` copies the pending buffer on every chunk, so a line of N bytes arriving in c-byte chunks copies ≈ N²/2c bytes. Measured with the installed SDK class and 8 KiB chunks: 44 KiB → 0.9 ms; 436 KiB → 2.2 ms (~12 MiB copied); 4 MiB → 159 ms (~1 GiB copied). With 64 KiB chunks the 436 KiB line costs 0.6 ms. Up to about 1 MiB per message this is noise next to embedding a query; past a few MiB it is the dominant cost and the reason Nx keeps a chunk list instead.
- **Hard ceilings.** `buffer.constants.MAX_STRING_LENGTH` = 536,870,888 UTF-16 units (V8's `String::kMaxLength`, `(1 << 29) - 24` on 64-bit; one line must become one string), `MAX_LENGTH` = 2^53 − 1 on Node ≥ 22 (2^32 on Node 20). `JSON.stringify` of a larger result throws `RangeError: Invalid string length` — the failure Nx hit.
- **`JSON.parse` / `JSON.stringify` cost.** Measured here: 0.03 ms each way for a 44 KiB `allowed` list, 0.3–0.4 ms for 436 KiB, i.e. on the order of 1 GB/s for this shape (short strings, no escapes). V8 made `JSON.parse` iterative and "up to 2.7× faster" in [v7.6](https://v8.dev/blog/v8-release-76) (2019; depth bounded by memory, not the native stack), and `JSON.stringify` "more than twice as fast" in [V8 13.8](https://v8.dev/blog/json-stringify) (2025: side-effect-free fast path, SIMD escape scanning, Dragonbox number printing, segmented output buffer). Node 24 ships V8 13.6, so the stringify speed-up is not in the measured numbers; Node 26 will have it.

## What this settles for the map

1. The daemon's wire needs no new framing for `corpus.*` and `lexical.*`: every planned message is under 0.5 MiB at 10,000 notes and under 70 KiB at the issue's 1,000-note vault, below what `embed.documents` already sends per batch.
2. Adopt the SDK's 10 MiB cap on purpose: construct `ReadBuffer` with an explicit `maxBufferSize` once the dependency allows it, and move `append` inside the `try` in `socket-server.ts` and `daemon-connection.ts` now, so an oversized line fails one connection rather than the process. That is a bug fix (direct PR), not a contract change.
3. `allowed` goes as a JSON array of paths; sending it costs well under 0.1 ms and ~45–70 bytes per note. A request that runs both legs should carry it once, which argues for a single daemon method per search rather than one call per leg, or for the lexical leg to accept the same array verbatim.
4. Leg results stay as the in-process types (`NoteResultNode[]`, `RankedNote[]`) serialized as-is; there is no size reason to trim fields or move to a binary encoding.
