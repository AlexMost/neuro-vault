# Vault Conventions

How a vault owner's `for-external-agents.md` reaches an agent: the two delivery channels, their size budgets, and what happens when the file is missing or oversized.

## What it is

Every vault may carry an optional file at `<vaultPath>/.neuro-vault/for-external-agents.md` — the vault owner's own guidance to an external agent about how *this* vault is organised. Note-type vocabulary, project-scoping convention, folder semantics, folders that are off-limits for writes. It is the one piece of context no tool description can supply, because tool descriptions describe the server, not the vault.

`.neuro-vault/` is also the home of `config.json`, an unrelated per-vault file read by a different subsystem: it names extra exclusion globs consumed when building the vault's discovery scope. See [`vault-scope.md`](./vault-scope.md) rather than this file for that contract — the two `.neuro-vault/` files share a directory but not a reader, a schema, or a failure model. (`.neuro-vault/` itself is always excluded from discovery, alongside every other dot-segment path, regardless of either file's presence.)

`src/lib/obsidian/vault-conventions.ts` owns the file: `CONVENTIONS_PATH` (the vault-relative location), `readVaultConventions(vaultPath)` (the best-effort read), `CONVENTIONS_CHAR_CAP` (the response-side size cap) and `capConventions(raw)` (the bounded slice). Every vault entry exposes the reader as `IVaultEntry.readConventions()`, built by `conventionsReaderFactory` in `IVaultEntryDeps` like every other per-entry dependency. One reader, so both channels agree by construction on where the file lives, what counts as empty, and what a failed read means.

## Why it exists

The content is delivered twice, over two channels with different guarantees.

**The overview channel — the one to rely on.** `computeVaultOverview` puts the text in a `conventions` field, which both surfaces inherit: the `get_vault_overview` tool response and the `vault://overview` resource. Tool responses arrive intact in every client we have measured, sub-agents included, and are not subject to the `instructions` cap. (Claude Code does apply a much larger, configurable cap to tool output.)

**The `instructions` channel — best-effort.** `buildServerInstructions` composes the same text into the MCP `instructions` string at startup. This channel is unreliable and we do not depend on it: Claude Code truncates `instructions` at exactly 2048 characters and hands sub-agents none of it at all; Cursor and Windsurf are untested and may differ again. It is still worth populating, because a client that renders `instructions` in full gets the conventions without a tool call.

The reasoning behind treating descriptions and responses as the channels that must carry load-bearing context is recorded in [ADR-0010](../adr/0010-context-delivery-channels.md).

## How it interacts

### The overview channel

```
entry.readConventions()  ──►  computeVaultOverview()  ──┬──► get_vault_overview  → response.conventions
   (readVaultConventions)         (capConventions)      └──► vault://overview     → payload.conventions
```

- **Read at call time, not cached.** The file is read on every overview call, so editing `for-external-agents.md` shows up in the next call with no MCP server restart. `get_vault_overview` is a once-per-session orientation call, so one small read costs nothing against a compute that already scans the vault.
- **Absent, never empty.** `conventions` is omitted from the payload entirely when the file is missing, empty, or whitespace-only. Not an empty string, not `null`, not a placeholder — a vault without the file returns exactly the payload it returned before this capability existed.
- **The value is trimmed.** `readVaultConventions` returns the file's content with leading and trailing whitespace stripped.
- **The description carries the authority.** `get_vault_overview`'s description states that the response carries the vault owner's rules for how the vault is organised and that they are to be followed when reading, writing, or organising notes there. Without that sentence the field is inert — the model has no reason to read it as authoritative rather than decorative. The sentence is deliberately scoped to vault organisation rather than an open-ended "follow these": the file sits in a directory the same server can write to, so an unconditional directive would let self-writable, per-call-fresh content instruct sub-agents about anything.

### The `instructions` channel

`buildServerInstructions(registry)` emits per-vault conventions blocks **first**, then `STATIC_SERVER_INSTRUCTIONS`:

1. One `## Vault-specific conventions` block per vault that has a non-empty file (in multi-vault mode the heading is `## Vault-specific conventions — <vault-name>`).
2. The server-authored preamble — currently 693 characters — carrying only what no tool description carries: the vault's role as a second brain, the operations-vs-semantic routing rule, and the project-scope discovery order.

Ordering is the whole point, and it is normative. Before this design the vault block was appended last, behind a 10,803-character preamble, so it began past ~11k characters and was unreachable at any file size. The vault block is the only content a client cannot obtain from tool descriptions, so it must occupy the part of the string that survives truncation.

The 2048-character budget is guarded by a test rather than by code. `test/server-instructions.test.ts` composes instructions for a representative ~1,200-character conventions file and asserts that the first 2048 characters contain both that file in full and the whole preamble. The measured total is 1,953 characters — a 1,227-character file plus its heading plus the 693-character preamble. Growing the preamble past that budget fails CI instead of silently re-breaking delivery.

Because composition happens once at startup, this channel does **not** pick up later edits. Freshness is an overview-channel guarantee only.

### Size cap and the truncation flag

`CONVENTIONS_CHAR_CAP` is **8,000 characters**, applied on the overview channel only (the `instructions` channel has the client's own budget, which the ordering rule addresses instead). When a file exceeds the cap, `capConventions` returns a bounded slice ending in a single `…` marker and the payload sets `conventions_truncated: true`. When the file fits, `conventions_truncated` is absent, so a consumer reading `conventions` without the flag can treat it as the complete file. Truncation is never silent.

The slice cuts at the last whitespace inside the cap window, so it ends on a word boundary rather than mid-token — unless no whitespace sits within `WORD_BOUNDARY_LOOKBACK_WINDOW` (200) characters of the cap, in which case it hard-cuts at the cap. Markdown can produce thousands of unbroken characters (a fenced code block, a long URL, a wide table row); the lookback bound stops a stray early space from collapsing an 8,000-character budget to almost nothing.

The cap is deliberate back-pressure toward compact conventions, not slack. A real `for-external-agents.md` measured 6,755 characters — 84% of the cap — so `conventions_truncated` is a live signal, not a theoretical one. Vault owners writing conventions should treat ~8,000 characters as the practical budget.

The shape (bounded slice plus visible flag) is the same idiom as `previewBody` in `src/modules/operations/preview-body.ts`, reused at a much larger cap rather than invented a second time.

### Multi-vault behaviour

Each vault's conventions travel with that vault, on both channels:

- **Tool fan-out** — when `get_vault_overview` is called with `vault` omitted, every `results_by_vault` entry carries the `conventions` of the vault it names, following the same present/absent and truncation rules as the single-vault path. One vault without a file does not affect another's entry.
- **Resources** — each per-vault `vault://<vault-name>/overview` carries only its own vault's conventions.
- **Instructions** — one block per vault, each attributed to its vault by name.

No extra wiring was needed for any of this: the field is produced at the compute layer, and both the fan-out and the per-vault resource registration already iterate registry entries.

### Failure is always absence

Reading the file is best-effort on both channels. A missing, unreadable, or permission-denied `for-external-agents.md` is treated as absent: `readVaultConventions` swallows the error and returns `null`, and `computeVaultOverview` additionally guards the call itself so that even a rejecting injected reader costs the caller nothing. `get_vault_overview` still returns its full structural snapshot with no `conventions` key and reports no error, and in fan-out the vault appears in `results_by_vault` — **not** in `failed_vaults`. Instructions composition still produces the preamble. An optional file must never be able to turn a working call into an error.

## Boundaries

- The 2048-character cap and the missing sub-agent `instructions` are client behaviour. This design routes around them; it does not try to fix them.
- No caching, no mtime check, no file watcher. Freshness comes from reading on each call.
- The cap is not enforced on the `instructions` channel — that channel's budget is the client's, and the ordering rule is what protects it.
- Nothing validates or parses the file. It is opaque owner-authored markdown, passed through trimmed and (if oversized) truncated.
- The file is not created, written, or migrated by the server. It is optional, and a vault without one is fully supported.

## Where the code lives

- `src/lib/obsidian/vault-conventions.ts` — path constant, reader, cap constant, cap helper.
- `src/lib/vault-registry.ts` — `IVaultEntry.readConventions`, `IVaultEntryDeps.conventionsReaderFactory`.
- `src/lib/obsidian/vault-overview.ts` — `conventions` / `conventions_truncated` on `VaultOverview`, produced by `computeVaultOverview`.
- `src/modules/operations/tools/get-vault-overview.ts` — the tool surface and the description sentence.
- `src/modules/operations/resources/vault-overview.ts` — the resource surface.
- `src/server.ts` — `STATIC_SERVER_INSTRUCTIONS` and `buildServerInstructions`.
- `test/server-instructions.test.ts` — ordering and the 2048-character budget guard.
- `test/lib/obsidian/vault-conventions.test.ts`, `test/lib/obsidian/vault-overview.test.ts` — reader, cap, and field behaviour.
