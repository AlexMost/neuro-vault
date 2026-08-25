<!--
Raw capture. This slice was not brainstormed from scratch in-session: it is the
fifth slice of a queue that a prior charting effort resolved decision by
decision (source: private research notes, "own embedding pipeline" map, tickets
06 "change detection and lifecycle", 07 "backend abstraction, fallback and the
switch criterion", 09 "final task slicing"). What follows is that decision log,
restated for this change, plus the three calls taken with the user on
2026-08-25 when the change was opened (Q10-Q12).
-->

# Brainstorm — serve semantic search from the own corpus

## Background

The server already owns an embedding corpus: `src/lib/obsidian/corpus/`
extracts, stores and reconciles it, `neuro-vault-mcp index` builds it from the
CLI, and the eval harness ranks against it through `eval/backends.ts`. Nothing
in the running server reads it. `VaultRegistry.create` still loads a Smart
Connections corpus per vault (`corpusFactory` → `.smart-env/multi`), and all
three semantic tools consume that snapshot.

Two facts make this the next slice rather than a later one:

- **It fixes a live regression.** `src/config.ts` still points at
  `.smart-env/multi`, a layout current Smart Connections versions no longer
  write. The semantic leg of `search_notes`, `get_similar_notes` and
  `find_duplicates` therefore serves a frozen corpus today, silently.
- **The corpus it should serve already exists and is already exercised.**
  `eval/backends.ts` reads `CorpusStore.listShards()` + `decodeVector` into
  exactly the `Map<string, SmartSource>` snapshot shape the ranking functions
  consume. Promoting that into `src/` is a screenful.

## Decision chain

**Q1 — Do the two corpora coexist, with Smart Connections as a fallback?**
No. The own corpus becomes the single backend, unconditionally and immediately;
there is no config flag choosing between them and no parity gate on the switch.
Motive: stop depending on an Obsidian installation and its plugins at all. A
fallback would also be dead code on arrival — the plugin's current storage
layout is one our loader cannot parse anyway.

**Q2 — What is the backend contract?**
A generalisation of the seam already in place, not a narrower one:

```ts
interface SemanticBackend {
  snapshot(): Promise<CorpusSnapshot>; // { sources, basenameIndex } — unchanged
  status(): BackendStatus; // { state, indexed?, total? }
}
```

The retrieval policy needs a keyed `Map` (`sources.get()` for expansion seeds
and block backfill), so the snapshot shape stays as it is and the three tools
do not change how they read it. `status()` is the new half: it feeds the
response status field, the "still building" error, and the startup selection
rule. The interface survives the removal of Smart Connections — it stays as a
test seam and as the extension point for a future second backend.

**Q3 — Cold start: block, or serve degraded?**
Never block. A full cold index is ~2.3 min for an 842-note vault; a server that
waits for it is unusable. Indexing runs in the background; until it finishes the
semantic leg of `search_notes` reports `{state: "indexing", indexed, total}` and
the lexical leg answers normally. `get_similar_notes` and `find_duplicates` have
no lexical half to fall back to, so they fail structurally with
`SEMANTIC_INDEX_BUILDING` carrying the same counters.

**Q4 — How does a finished index reach a live server?**
Atomic promotion, no restart: the entry's active backend is swapped once the
build completes. Per vault, independently.

**Q5 — What keeps the corpus fresh afterwards?**
A full reconcile at startup plus an in-process chokidar watcher with a ~10 s
debounce. Chokidar over `fs.watch`: it smooths duplicate events and rename
quirks, and `awaitWriteFinish` covers Obsidian's temp-then-rename saves; its
native dep is optional with a JS fallback, so `npx` distribution is unaffected.
A watcher that dies degrades to reconcile-on-start and logs — it never kills the
server. Per-call staleness checks (the Smart Connections loader's directory
signature) are dropped for the own corpus: startup reconcile plus the watcher
close every path a change can arrive by. Write-through from the write tools is
not added — the watcher sees the server's own writes.

**Q6 — Multi-vault: what is shared and what is per vault?**
Backend, watcher, reconcile and status are per vault entry, mirroring the
registry. Exactly one thing is process-global: `EmbeddingService`, with a single
embed queue, so concurrent cold indexes of several vaults share one ONNX
instance instead of fighting over it. Strictly sequential per-vault indexing was
rejected — it leaves the second vault in `indexing` for no reason.

**Q7 — Can semantic be turned off for one vault?**
Two levels. Globally, the existing CLI `--no-semantic` behaves as it does today:
the module never comes up and the semantic tools are not registered. Per vault,
`"semantic": false` in `.neuro-vault/config.json` (the file `unified-vault-scope`
introduced) means no indexing, no watcher, nothing written under
`.neuro-vault/corpus/`; the lexical leg works, `search_notes` reports
`{state: "disabled"}`, and the two embeddings-only tools return
`SEMANTIC_DISABLED` pointing at the config key. The global flag wins over the
per-vault one. This is why `BackendStatus.state` needs `"disabled"` next to
`"unavailable"`: deliberately off is not broken.

**Q8 — One backend per what?**
Per vault entry, hard. All three semantic tools of one vault read the same
active backend; mixing corpora inside a vault is forbidden. "One per process"
would break multi-vault dispatch. Promotion switches every reader of that vault
at once.

**Q9 — Does Smart Connections code go away here?**
No — that is the next slice, and it is gated on a diagnostic parity run that has
not happened yet. Here the loader simply stops being on any execution path the
server takes; the eval harness still reaches it directly through its own
`--backend sc` axis.

> **Amended 2026-08-25 (Q13).** This answer was the map's, written before the
> parity run ran. It has since run and closed: parity was established on the 20
> golden entries the plugin corpus could serve (hit@3 identical, MRR within
> noise, p@3 favouring the own corpus), and the remaining 5 are permanently
> unmeasurable — the plugin migrated its storage layout to one our reader cannot
> parse. With the gate met, keeping the code buys a dead-code window and a
> duplicated doc sweep, so the removal slice is absorbed here. See design D13.

## Calls taken when the change was opened (2026-08-25)

**Q10 — ADR for the watcher?** Yes, a new ADR. ADR-0013 established that the
server owns a corpus; it says nothing about the server keeping it fresh in the
background. The new runtime dependency, the debounce, the degradation path and
the honest restatement of the "zero infrastructure" claim belong in one numbered
decision.

**Q11 — Delivery shape?** One PR. The contract change, the backend, the watcher
and the doc sweep land together.

**Q12 — Is `semantic_status` always present?** Always, including
`{state: "ready"}`. A client must not have to read the absence of a field as
"everything is fine"; an omitted field cannot be distinguished from an older
server.

**Q13 — Do we still defer the Smart Connections removal?** No. The gate it was
waiting on is closed, and after this slice nothing reads that code — not the
server, and not the harness's `sc` axis, which cannot load a current plugin
corpus. The removal is absorbed into this change; the PR closes both issues.

## Trade-offs accepted

- **The README's "zero infrastructure" claim narrows.** No database and no
  external processes stay true; "no background processes, no watchers" does not.
  It gets restated rather than quietly deleted.
- **First run on a fresh vault is degraded, not broken.** Minutes of
  lexical-only `search_notes` and two tools that refuse, in exchange for a
  server that starts instantly. `neuro-vault-mcp index` exists for anyone who
  would rather warm the corpus first.
- **A vault with `"semantic": false` still advertises the semantic tools.** They
  are registered process-wide because other vaults need them; the disabled vault
  answers with a code instead of hiding the tool.
