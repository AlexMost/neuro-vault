# Retrieval Eval Harness

An offline tool that measures the ranking pipeline's retrieval quality against
a hand-curated golden set. It runs as a plain script — no MCP client, no
running server — by importing the production ranking modules directly
(`executeRetrieval`, `LexicalIndex.search`, `flattenExpansion`, `fuseRanks`)
and calling them the way `search_notes` does. It exists to replace "judge a
ranking change by hand-running a few queries" with a repeatable number: the
own-embedding effort needs to show the own corpus is at least not worse than
Smart Connections before the Smart Connections code is deleted, and every RRF
weight (`EXPANSION_WEIGHT`, pool sizes, adaptive `k`) was hand-picked and can
only be re-tuned against measured data.

## Golden set

The runner reads a fixed, unconfigurable path: `<vault>/.neuro-vault/eval/golden.yaml`.
It lives in the **vault's** own git repository, not this one — it's
hand-curated private data (comments, Cyrillic, hand edits), not
machine-generated output. The `.neuro-vault/` prefix is a dot-segment, so it's
already invisible to indexing and search under this repo's unconditional
dot-path exclusion rule — no exclusion config needed.

It's a YAML list of entries:

```yaml
- id: q001
  query: "release flow"
  lang: en
  source: 2026-W20
  relevant:
    - Reflections/release flow.md
- id: q002
  query: "векторний пошук"
  lang: ua
  relevant:
    - Ideas/embeddings.md
    - Tasks/rag.md
```

- `id` — non-empty, unique within the file.
- `query` — non-empty string, passed to the pipeline verbatim.
- `lang` — `ua` or `en`; drives the per-language metric slice.
- `source` — optional freeform provenance note (when/how the entry was curated); not used by scoring.
- `relevant` — non-empty list of vault-relative note paths. Relevance is
  **binary**: the pipeline ranking any one of these paths counts as a hit for
  that query. There's no partial credit and no graded relevance — a binary
  set is a degenerate graded set and upgrading later is easy, whereas
  strict top-1 or NDCG-style grading is brittle at the golden set's likely
  size ("different note but still relevant" would read as a false failure).

Structural problems — a missing `query`, an unknown `lang`, a duplicate `id`,
an empty `relevant` list — fail the run immediately, naming the offending
entry.

**Every `relevant` path is also checked against the vault's scoped note
listing before any query is embedded** — the same listing the corpus and the
lexical index are built from, not a bare filesystem check. A note that moved
or was renamed silently turns its query unwinnable — the ranking wouldn't have
degraded, but the metric would — and so do three entries a filesystem check
waves through: a case-mismatched path on a case-insensitive volume
(`Notes/Foo.md` for `Notes/foo.md`), a note the vault's scope excludes (or one
under a dot-segment), and a path escaping the vault root (`../outside.md`).
So a broken path is treated as the golden set's own "compile error": the run
exits non-zero, lists every broken `id` + path in one pass (not just the
first), and writes no report. Fix the entry (or move the note back) and
re-run.

## Running

```sh
npm run eval -- --vault <path> --pipeline semantic|fused --backend sc|own
```

`--pipeline` defaults to `semantic`, `--backend` to `own`. An unrecognized
flag, a missing value, or an unknown `--pipeline`/`--backend` value fails
immediately with the supported values.

- `--backend own` reads `<vault>/.neuro-vault/corpus/` — the shard store this
  server owns and reconciles. It must already exist:
  run `neuro-vault-mcp index --vault <path>` first, or the run fails naming
  that command.
- `--backend sc` reads the vault's Smart Connections corpus at
  `<vault>/.smart-env/multi`. It must already exist: open the vault in
  Obsidian with Smart Connections installed so it builds its embeddings, or
  the run fails naming the missing/empty corpus.

## Axes: pipeline × backend

Two independent axes, both recorded in every report:

- **`--pipeline`** — the ranking method.
  - `semantic` — embed the query, rank by pure embedding similarity
    (`findNeighbors`, threshold 0, top 10).
  - `fused` — the production RRF pipeline, run at deep effort: `executeRetrieval`
    (semantic leg, pool 8, expansion on, floor 0.35) + `LexicalIndex.search`
    (note cap 10, per-note cap 3, real wikilink-graph backlink tie-break) +
    `flattenExpansion` + `fuseRanks` (expansion weight 0.85). This is the same
    sequence `search_notes` calls internally to assemble its unified list,
    minus the MCP response envelope — so a `fused` eval run measures the real
    production ordering, not a reimplementation of it.
- **`--backend`** — the vector source: `sc` (Smart Connections) or `own`
  (this server's own corpus). Both produce the same in-memory snapshot shape,
  so the same pipeline code runs unchanged over either.

Keeping these orthogonal is what makes a parity run meaningful: a
`--backend sc` vs `--backend own` comparison at the same `--pipeline` isolates
"did the vectors change", separate from "did the ranking method change".

`--backend` (and the `sc` value along with it) is temporary — it's removed
together with Smart Connections itself once that migration lands (#88), at
which point every run is implicitly `own`.

## Scoring

Every query is scored against its pipeline's **top-10** ranked paths, computed
at **similarity threshold 0** — positions only, no score filtering. Production
similarity thresholds (0.5/0.35 plus fallback) are calibrated to one
embedding model's similarity scale, so they're not meaningful across models or
backends; the harness deliberately ignores them rather than let threshold
tuning masquerade as ranking quality.

From that top-10, three metrics are computed, each over three slices
(`overall`, `ua`, `en`):

- **precision@3** — mean of `|relevant ∩ top-3| / 3`.
- **MRR** — mean of `1 / rank of first relevant hit`, `0` when no relevant
  path appears in the top-10.
- **hit@3** — fraction of queries with at least one relevant path in the
  top-3.

## Reports and comparability

Each run writes one JSON file to `eval/results/` (gitignored — reports are
machine-generated and tied to a code SHA, not durable artifacts), named
`<yyyy-mm-ddThh-mm-ss>-<pipeline>-<backend>.json`. It carries:

- `code_sha`, `vault_sha` — `git rev-parse HEAD` in this repo and in the
  vault, respectively, with a `-dirty` suffix when the working tree has
  uncommitted changes. Either is `null` when that directory isn't a git
  repository, or git was unavailable — never a fabricated value.
- `model_id`, `pipeline`, `backend` — which combination produced this report.
- `config` — every knob in effect (pool sizes, thresholds, fusion weight, the
  adaptive-`k` policy), so a run with different knobs is distinguishable at a
  glance.
- `golden` — the golden set's path and entry count.
- `metrics` — the three slices described above.
- `per_query` — each query's ranked top list and first-relevant-rank, for
  diffing individual queries between two runs.

**Two reports are comparable if and only if their `vault_sha` values are
equal and clean** (both non-null, neither `-dirty`). This is the harness's
core discipline: it's a paired-comparison instrument on one fixed vault
state, not an absolute ruler across time — a `vault_sha` mismatch means the
underlying notes differ, so any metric delta could come from the data, not
the pipeline.

That rule has a sharp edge worth calling out explicitly: the `fused`
pipeline here deliberately skips production's live existence filter (the
check `search_notes` runs to drop corpus paths that no longer exist on disk
before fusing them into the result). A stale corpus can therefore still rank
a note that was deleted from the vault. Matching `vault_sha` guarantees the
*golden set's* paths were valid at run time — it does not by itself guarantee
the *corpus* is fresh. A comparison across backends or pipelines — the
`sc` vs `own` parity run in particular — is only valid when both corpora were
freshly built or reconciled against that same vault state; a comparison
against a stale `own` corpus can look artificially better or worse than it
should.

Since reports are gitignored and local, there's no built-in history. Durable
baseline numbers are meant to be transcribed by hand into wherever they need
to live for the long term — a vault task note, the SC-removal change — rather
than kept as a growing pile of JSON files.

## Pointers

- Golden-set curation (writing the real entries): #86.
- The `sc` vs `own` diagnostic parity run, ahead of the Smart Connections
  removal: #87.
- Smart Connections removal, which also retires `--backend`: #88.
