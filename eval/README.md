# Retrieval Eval Harness

An offline tool that measures the ranking pipeline's retrieval quality against
a hand-curated golden set. It runs as a plain script — no MCP client, no
running server — by importing the production ranking modules directly
(`executeRetrieval`, `LexicalIndex.search`, `flattenExpansion`, `fuseRanks`)
and calling them the way `search_notes` does. It exists to replace "judge a
ranking change by hand-running a few queries" with a repeatable number: every
RRF weight (`EXPANSION_WEIGHT`, pool sizes, adaptive `k`) was hand-picked and
can only be re-tuned against measured data.

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
npm run eval -- --vault <path> [--pipeline semantic|fused] [--model <key>] [--stats [--baseline <report.json>]]
```

- `--pipeline` defaults to `semantic`.
- `--model` names an embedding model profile and defaults to the registry
  default (`DEFAULT_MODEL_KEY` in `src/lib/model-profiles.ts`;
  currently `harrier-270m`; see [Axis: model](#axis-model)).
- `--stats` adds the calibration statistics to the report and the printout
  (see [Calibration](#calibration)); it works on the `semantic` pipeline only.
- `--baseline` names an earlier `--stats` report to calibrate against, and is
  only valid together with `--stats`.

An unrecognized flag, a missing value, an unknown `--pipeline` or `--model`
value, `--baseline` without `--stats`, or `--stats` with `--pipeline fused` fails
immediately — naming the supported values where there are any.

The run reads `<vault>/.neuro-vault/corpus/<model_key>/` — the shard store this
server owns and reconciles, in the directory of the profile you pass to
`--model`. It never builds, migrates, locks or deletes anything there: that
model's corpus must already exist **and have been built by the profile you pass
to `--model`**, or the run fails naming the `neuro-vault-mcp index` command that
fixes it (see below). A vault still on the single-corpus layout that preceded
per-model directories is moved into its model's directory by the first server or
`index` pass over it, not by `eval`.

## Axis: model

- **`--model <key>`** — which embedding model profile the run uses. One profile
  per run: the same profile embeds every golden query (through the same provider
  the server uses, so a profile's query prefix is applied) and supplies the
  similarity defaults the run reads (the `fused` expansion floor, and the
  thresholds `--stats` reports on). An unknown key fails with the list of
  supported ones.

A model's corpus holds vectors from exactly one model, and a query vector is only
meaningful against vectors from the same model — different models can even share
a width and then score as noise rather than fail. So before any query is
embedded, the runner compares the corpus manifest with the selected profile
(embedding version, model key and id, dimensions and indexing strategy) and
refuses to run on a mismatch. It reads the manifest ahead of listing shards, so
a corpus of another width is refused on its manifest instead of failing shard
by shard. There are three refusals, each naming the command that fixes it:

- the selected model's corpus is missing or empty — the message names its
  directory and, when other models' corpora exist in the vault, lists them;
- the model's corpus was built with another identity (a different revision,
  `embed_version`, dtype, …) — the message names both the stored and the
  requested identity;
- the model's corpus has no readable manifest.

The command is `neuro-vault-mcp index --vault <vault> --model <key>`, with
the resolved vault root and the selected profile's key (the default when
`--model` is omitted).

**Reproducing a model comparison** (a bake-off) means, for each profile:

```sh
neuro-vault-mcp index --vault <copy> --model <key>
npm run eval -- --vault <copy> --model <key>
```

Each profile has its own corpus directory in the vault, so comparing models is
an A/B and destroys nothing: `index --model X`, `eval --model X`, `index --model Y`,
`eval --model Y`, with both corpora kept (a corpus that was already built is
reused, not re-embedded). A server on another `--model` serving the same vault
does not interfere either — it reads and writes its own directory, and passes
over one vault take turns on a lock. Running the loop on a **copy** of the
vault is still reasonable: the copy keeps its `.git`, so `vault_sha` stays
meaningful, along with its golden set, and your live vault gains no extra
corpus directories. When you are done, `neuro-vault-mcp index --vault <vault>
--model <key> --prune` removes the other profiles' corpora. Compare the resulting
reports on `--pipeline semantic` (see [Scoring](#scoring)).

## Axis: pipeline

- **`--pipeline`** — the ranking method.
  - `semantic` — embed the query, rank by pure embedding similarity
    (`findNeighbors`, threshold 0, top 10).
  - `fused` — the production RRF pipeline, run at deep effort: `executeRetrieval`
    (semantic leg at threshold 0, pool 8; expansion leg on, per-seed limit 3,
    expansion floor from the selected profile) + `LexicalIndex.search`
    (note cap 10, per-note cap 3, real wikilink-graph backlink tie-break) +
    `flattenExpansion` + `fuseRanks` (expansion weight 0.85). This is the same
    sequence `search_notes` calls internally to assemble its unified list,
    minus the MCP response envelope — so a `fused` eval run measures the real
    production ordering, not a reimplementation of it. That claim is pinned:
    `test/eval/production-fusion-pin.test.ts` ranks one query both ways over a
    fixture vault and asserts the two path orders are identical, so a change
    to production's fusion that the harness doesn't follow fails the suite.

## Scoring

Every query is scored against its pipeline's **top-10** ranked paths, computed
at **query-side similarity threshold 0** — positions only, no score filtering.
Production's query↔note thresholds (the profile's `quick` and `deep` defaults
plus its `fallback`) sit on one embedding model's similarity scale, so they
aren't comparable across models; the harness zeroes them rather than let
threshold tuning masquerade as ranking quality. The ranked list still carries
each path's score, so a threshold can be judged afterwards (see
[Calibration](#calibration)).

The expansion leg's floor is the deliberate exception: **`expansion_floor` is
the selected profile's own default** (`ModelProfile.similarity.expansionFloor`).
It is a similarity threshold too, but on the seed↔note scale rather than the
query↔note one, and zeroing it would stop the `fused` pipeline from being the
production pipeline for that profile — which is the whole point of that
pipeline. The cost is a caveat, worth stating plainly:

> A cross-model comparison of `fused` is not clean. Under a model change the
> expansion leg's membership shifts with the new model's similarity
> distribution and with its own floor, while the semantic leg's (threshold 0)
> does not, so part of a `fused` metric delta can come from the floor rather
> than from ranking quality. **`--pipeline semantic` is the clean cross-model
> read.** The floor actually in effect is always recorded as
> `config.expansion_floor`, so a report never hides which value produced its
> numbers.

Within one model — an RRF re-tuning, for instance — the floor is a constant
across runs and the caveat doesn't apply.

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
`<yyyy-mm-ddThh-mm-ss>-<model_key>-<pipeline>.json`. It carries:

- `code_sha`, `vault_sha` — `git rev-parse HEAD` in this repo and in the
  vault, respectively, with a `-dirty` suffix when the working tree has
  uncommitted changes. Either is `null` when that directory isn't a git
  repository, or git was unavailable — never a fabricated value.
- `model_key`, `model_id`, `identity`, `pipeline` — which combination produced
  this report. `model_key` is the profile the run was invoked with; `identity`
  is the full embedding identity the corpus was gated against and the queries
  were embedded under (provider, model key and id, revision, dtype, dimensions,
  pooling, max tokens); `model_id` repeats `identity.model_id`.
- `config` — every knob in effect (pool sizes, thresholds, the profile's
  expansion floor, fusion weight, the adaptive-`k` policy), so a run with
  different knobs is distinguishable at a glance.
- `golden` — the golden set's path and entry count.
- `metrics` — the three slices described above.
- `per_query` — for each query: its ranked top list (`top`) with the score each
  path was ranked by (`top_scores`, parallel to `top`), the 1-based ranks of
  every relevant path inside it (`relevant_ranks`), the first of them
  (`first_relevant_rank`, `null` when none), the per-query metric values, and
  `best_relevant_similarity` — the best cosine between the query and any of its
  relevant notes **whether or not that note was ranked** (`null` when none of
  them has a vector). It is the evidence a threshold needs for notes the top
  list never reached. `top_scores` are cosine similarities for `semantic` and
  fused RRF scores for `fused`; `best_relevant_similarity` is a cosine either
  way. Together they let two runs be diffed query by query.
- `stats` — the calibration statistics; present only on a `--stats` run (see
  [Calibration](#calibration)).

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
the *corpus* is fresh. A comparison across pipelines is only valid when the
corpus was freshly built or reconciled against that same vault state; a
comparison against a stale corpus can look artificially better or worse than
it should.

Since reports are gitignored and local, there's no built-in history. Durable
baseline numbers are meant to be transcribed by hand into wherever they need
to live for the long term — a vault task note — rather than kept as a growing
pile of JSON files.

## Calibration

`--stats` answers a question the ranking metrics can't: *where do this
profile's similarity thresholds sit on its own scale?* A threshold is only
meaningful against the distribution it filters, and models differ in that
distribution. With no labelled data for most thresholds, the defensible target
is to **reproduce the behaviour a threshold had on a model it was tuned for** —
the same share of its population passing — rather than to maximise a golden-set
metric (the harness ranks at threshold 0, so positions give a threshold nothing
to maximise).

A `--stats` run adds a `stats` object to the report and prints a summary. It
measures seven populations, each summarised by quantiles (`n`, `min`, `p05`,
`p10`, `p25`, `p50`, `p75`, `p90`, `p95`, `max`). Three are ranked (cut to a
top-k), three are their unranked counterparts, and `note_max` is one value per
note:

| population             | what it holds                                                                          | thresholds it feeds         |
| ---------------------- | -------------------------------------------------------------------------------------- | --------------------------- |
| `query_candidates`     | query↔note similarities of each golden query's top-10 candidates (ranked)              | none (diagnostic)           |
| `expansion_neighbours` | seed↔neighbour similarities the expansion leg sees, before its floor (ranked)          | none (diagnostic)           |
| `note_top10`           | every note's top-10 neighbour similarities (ranked)                                    | none (diagnostic)           |
| `query_all`            | each golden query against every note (unranked)                                        | `quick`, `deep`, `fallback` |
| `seed_all`             | each seed against every note that is not one of that query's seeds (unranked)          | `expansionFloor`            |
| `note_all`             | each note against every other note, ordered pairs (unranked)                           | `similarNotes`              |
| `note_max`             | every note's maximum similarity to any other note                                      | `duplicates`                |

The defaults are matched on the **unranked** populations. On `bge-micro-v2` five
of the six defaults passed 100 % of the ranked top-10 populations: a cut to the
ten nearest keeps only values above every threshold, so the pass rate says
nothing and two different thresholds look identical. The unranked populations
include the values a threshold exists to reject, so a pass rate below 100 % is
what they report. The ranked populations stay in the report for comparison. See
design D11 in
[`openspec/changes/archive/2026-10-13-embedding-model-profiles/design.md`](../openspec/changes/archive/2026-10-13-embedding-model-profiles/design.md).

For each of the six defaults on the selected profile, `pass_rates` records its
threshold, the population it filters and the share of that population at or
above the threshold.

`note_all` holds N·(N−1) similarities for N in-scope notes with a vector (787 656
for the 888-vector vault measured here), and the run keeps them in memory, so
memory use grows with the square of the vault. JavaScript arrays are capped at
2^27 elements, so `--stats` refuses vaults above 11 000 note vectors up front
(`MAX_STATS_SOURCES` in `eval/stats.ts`):
it is a calibration tool for vault-sized samples, not for very large vaults.

### Guards

Two golden-set checks guard a threshold against costing recall where labels
exist. They are reported under `guards`:

- `deep_filtered_first_relevant` — queries whose first relevant hit lies inside
  the deep pool but scores below the profile's `deep` default. **Target: 0.**
- `quick_hit_at_3_drop` — queries that have a relevant note in the top-3 at
  threshold 0 but lose it once the ranking is filtered at the profile's `quick`
  default. **Target: ≤ 1.**

Two properties of the guards are worth knowing:

1. They read `top_scores` as **cosine similarities**. That is why `--stats` is
   `semantic`-pipeline only — a `fused` run's scores are RRF scores, and
   comparing them with a similarity threshold is meaningless.
2. They model a **plain threshold filter**, not production's one-shot fallback
   retry. Production retries once at `fallback` when a default threshold finds
   nothing; the guards don't. A query whose best hit sits between `fallback` and
   `quick` therefore counts as lost, although production would recover it. The
   guards are conservative: they never under-report a loss.

The harness only reports the guards; lowering a threshold until they pass is the
operator's step.

### Baseline and suggested thresholds

`--baseline <report.json>` takes an earlier `--stats` report (anything else — an
unreadable file or a report without `stats` — fails before any query is
embedded). For each of the six defaults it reads the baseline's pass rate and
adds a `suggested` entry to the new report: the threshold on _this_ run's
population at which that same share passes (`baseline_pass_rate` and
`threshold`). The printout appends `→ suggested <threshold>` to each line. The
suggestion matches distributions only — it does not look at the guards. A
threshold passes every value at or above it, so tied values (the note
populations always hold them: a mutual-nearest pair counts twice) move
together; the suggestion is the threshold whose pass rate comes closest to the
baseline's, the more permissive one on an exact tie. On an empty population
there is nothing to match: `threshold` is `null` and the printout says so.

The baseline's pass rates are validated up front: each of the six must be a
number in [0, 1], otherwise the run fails naming the file and the key. Each must
also have been measured on the population this build uses for that default
(`pass_rates.<key>.population`): a baseline captured on the ranked populations
is refused, naming the file, the key and both populations, because its pass
rates mean something else — re-capture it with `--stats`. The new
report records which baseline the suggestions came from as `stats.baseline`
(`file` (the resolved path), `model_key`, `vault_sha`, `code_sha`). If the baseline's
`vault_sha` differs from this run's, or either is unknown or `-dirty`, the run
prints one warning line to stderr that the two reports are not comparable (see
[Reports and comparability](#reports-and-comparability)) — the run still
completes, and the suggestions are then only as good as the vaults are alike.

### Procedure

1. **Take the baseline first.** On the profile whose thresholds you want to
   reproduce, against a corpus built by it, run
   `npm run eval -- --vault <copy> --model <key> --stats` and keep the report.
   Each profile's corpus is kept beside the others, so indexing the vault for
   another profile does not take this baseline away — unless you `index --prune`
   that corpus, or the vault's notes change.
2. **Per profile:** index the vault copy with it, then run
   `npm run eval -- --vault <copy> --model <key> --stats --baseline <baseline report>`
   and read each default's `suggested` value.
3. **Write the chosen values** into the profile's `similarity` in
   `src/lib/model-profiles.ts`.
4. **Check the guards on the new values.** Re-run
   `npm run eval -- --vault <copy> --model <key> --stats` (no re-index — the
   corpus is the same): the guards evaluate the profile's _current_
   `similarity`, not the `suggested` ones, so only this run reflects what you
   wrote in step 3. If either guard misses its target, lower the threshold
   (`deep` for the first, `quick` for the second), repeat this step until it
   passes, and record the adjustment.
5. **Record** the baseline pass rates, the per-profile values and the guard
   results where the decision lives (an ADR and the retrieval-policy
   architecture doc), not in a growing pile of local reports.

## Pointers

- Golden-set curation (writing the real entries): #86.
