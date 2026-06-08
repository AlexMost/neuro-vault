<!--
Raw capture of the brainstorming for this change.

The creative exploration was already done outside this session: the framing, candidate
list, overlap hypotheses, and audit method live in the vault task note
`Tasks/neuro-vault/Аудит перекриття малозадіяних MCP-тулів` (itself distilled from the
W23 + W24 tool-usage reports under `Inbox/neuro-vault-usage/`). The audit proper — reading
each tool's source and verifying overlap against the live vault — was run in this session,
and the three remaining product forks (the disposition of `read_property`, `list_properties`,
and `get_stats`) were resolved live with the user via AskUserQuestion. This file captures that
completed work as a decision log; it does not re-run the brainstorming skill, because doing so
would re-litigate decisions the user has already made.
-->

# Brainstorm — Audit overlap of underused MCP tools

## Background

The W23 + W24 tool-usage reports flagged four tools that were called in **zero** buckets two
weeks running — `find_duplicates`, `get_note_links`, `list_properties`, `remove_property` —
plus two more used rarely and pointwise: `get_stats`, `read_property`. Every extra tool widens
the surface ToolSearch must scan for schemas and adds noise to the `unusedTools` signal.

The trap the task names explicitly: **"not called" ≠ "duplicate."** A tool can be unused this
fortnight and still be the _only_ way to do something. So the deliverable is an **audit**, not a
blind purge: for each of the six candidates, decide whether its function is genuinely covered by
another tool (→ remove / merge) or is unique (→ keep, possibly with a "when to reach for it"
nudge).

## Method (run in this session)

For each candidate: (1) read its source to pin down exactly what it does and returns;
(2) state the overlap hypothesis — which tool(s) would give the same result; (3) **verify on a
real example** against the live vault; (4) reach a verdict with the evidence attached.

## Decision chain (per candidate)

### get_stats → **remove** (by decision, not by coverage)

Source: reports `{ totalNotes, totalBlocks, embeddingDimension, modelKey }` from the _embedding
corpus_. Live check: `get_stats` → `704 notes / 16,595 blocks / dim 384 / bge-micro-v2`, while
`get_vault_overview` → `574` notes (a disk scan). **Nothing else reports block count, embedding
dimension, model, or the corpus count** — and the 704↔574 gap is itself a staleness signal
(orphaned embeddings). It also lives in the **semantic** module, so its fields cannot fold into
the operations-module `get_vault_overview` without coupling the two. Verdict per evidence was
_keep_. The user was shown this and chose to **remove anyway** — a deliberate surface cut,
accepting the loss of in-MCP corpus diagnostics (diagnosable outside the server). Recorded
honestly: this removal is not deduplication.

### list_properties → **remove outright**

Source: `{ name, type, count }` for **all** frontmatter keys. Hypothesis: covered by
`get_vault_overview`, which returns the same `properties` shape. Live check: overview returns the
identical list but **capped at top-30**; this vault has 36 keys, so the rare/zero-count tail
(`blocked_by`, `excalidraw-plugin`, and four `count: 0` keys) is dropped. So it is _not_ a strict
subset. Options weighed: remove + lift the 30-cap on overview (no capability loss); remove
outright (lose the tail); keep + nudge. The user chose **remove outright** — the lost tail is
mostly `count: 0` noise and the top-30 covers every key that matters. `get_vault_overview` is
unchanged (still top-30). Note: `provider.listProperties()` stays — `get_vault_overview` calls it.

### read_property → **remove**

Source: returns `{ vault, value }` for one frontmatter key; accepts `name` or `path`. Hypothesis:
covered by `read_notes(fields: ['frontmatter'])`. Live check: `read_property(path, 'status')` →
`"todo"`; `read_notes` / `query_notes` return the same value inside the full frontmatter object —
**no data loss**. The only unique sliver is ergonomic (value-only return + `name` lookup), and the
parameter dictionary already steers `name → path` resolution. `docs/guide/routing.md` currently
_recommends_ it, so removing it has a doc dependency. The user confirmed **remove**.

### get_note_links → **keep**

Source: returns the full incoming + outgoing wikilink edge lists. Live check: for the task note,
`incoming: [Daily/2026-06-08]`, five `outgoing` targets with `resolved`/path. `query_notes` returns
only `backlink_count: 1` (a number, no list); `get_similar_notes` ranks/merges neighbours and never
exposes the raw adjacency or unresolved targets. **Sole source of edge lists.** Unique → keep.

### find_duplicates → **keep**

Source: vault-wide all-pairs near-duplicate sweep (default threshold 0.9). Live check: returned
**1,169 pairs** (e.g. `Daily/2026-04-18` ≈ `Daily/2026-04-19` @ 0.9986). `get_similar_notes` is
single-source (neighbours of one note); reproducing the sweep would mean N calls + manual pair
dedup. Different operation → keep.

### remove_property → **keep**

Source: deletes a frontmatter key — the inverse of `set_property`. Verified by contract (not
executed, to avoid mutating the vault): `set_property` only sets/overwrites; `edit_note` preserves
frontmatter byte-for-byte in both modes. **No other tool can delete a frontmatter key.** Unique →
keep.

## Agreed approach

1. **Remove three tools** from the MCP surface: `read_property`, `list_properties` (operations
   module), `get_stats` (semantic module). Operations 12 → 10 tools; semantic 4 → 3.
2. **Keep three** unused-but-unique tools: `get_note_links`, `find_duplicates`, `remove_property`.
   Add a short "when to reach for it" nudge for each in `AGENTS.md` (the task's "коли його тягнути"),
   so future sessions don't re-flag them as dead.
3. **Scrub references** to the three removed tools from all _live_ docs (guides, architecture,
   README) and the parameter dictionary; re-route the routing/troubleshooting examples that pointed
   at them. `docs/superpowers/` is frozen — not touched.
4. **Breaking change** (a tool disappearing from the contract) → major version **10.1.0 → 11.0.0**.
5. **Verification:** `npm test`, `npm run lint`, `npx tsc --noEmit` all green; tests for the three
   removed tools are deleted (not skipped) and the suite count drops intentionally.

## Out of scope

- `get_similar_notes` — used episodically; in scope only as a possible overlap for `find_duplicates`
  (it isn't one). Stays.
- Touching `get_vault_overview`'s behaviour (e.g. lifting the property cap) — the user chose to
  remove `list_properties` outright, so overview is unchanged.
- The two sibling MCP cleanups (`Preview-режим тіла для read_notes`, `Толерантність аргументів
query_notes`) — separate tasks.
