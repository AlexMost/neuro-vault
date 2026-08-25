# Brainstorm — retrieval-eval-harness

Raw capture. Format: background → decision chain → trade-offs.

**Provenance note.** The brainstorming for this change did not happen in this
session. It happened in two places:

- The original harness design session of **2026-08-08**, recorded in the vault
  note `Archive/Retrieval eval harness.md` (archived 2026-08-24 — "planning
  finished, execution tracked on GitHub", issue #84). That session fixed the
  golden-set format, the metrics, the runner interface and the mining process.
- The wayfinder effort "own embedding pipeline"
  (`.scratch/own-embedding-pipeline/`, label `wayfinder:map`), specifically
  [`issues/08-eval-harness-delta.md`](../../../.scratch/own-embedding-pipeline/issues/08-eval-harness-delta.md)
  — a grilling session with the user resolved **2026-08-23** that reconciled
  the 2026-08-08 design with the map's decisions (golden set moved into the
  vault, `--pipeline` × `--backend` axes, `NEURO_VAULT_EVAL_DATA` killed).
- Two post-map amendments arrived as comments on issue #84 (from the explore
  session on #86, **2026-08-25**): `vault_sha` in the JSON report, and
  relevant-path validation at runner startup.

The scratch directory is uncommitted and the vault note lives outside this
repo, so this file transcribes every decision the implementation depends on
rather than relying on those links. It does not re-open them. Slice-local
calls the map left to the implementation slice are resolved below (Q9–Q13)
with reasonable defaults; the user's instruction was "беремо задачку #84".

## Background

Every ranking change so far (RRF in 14.0.0, weighted expansion in 15.0.0,
threshold splits) has been justified by anecdote: a handful of hand-run
queries in a live session. The harness makes retrieval quality measurable —
a golden set of real queries with known-relevant notes, run against the
ranking pipeline as a library, producing comparable JSON reports.

The harness has two customers:

1. **The corpus migration** (this effort's queue). The diagnostic parity run
   (#87) compares `--backend sc` vs `--backend own` on the same golden set —
   "at least not worse" is the gate for deleting the Smart Connections code
   (#88), and the baseline SC numbers get durably recorded before SC dies.
   Later, `embed_version` bumps (e.g. the model upgrade in #98, or a better
   note-vector strategy) are judged by the same golden set instead of vibes.
2. **RRF weight re-tuning.** `EXPANSION_WEIGHT = 0.85`, adaptive `k = √N`
   (clamped 5..60) and the leg thresholds were hand-picked; the harness turns
   tuning into "several runs + compare reports".

Queue position: slice #4 of the six-change queue from the map's final slicing
(ticket 09). Slices #1–#3 have shipped: `unified-vault-scope` (#90, 15.4.0),
`own-corpus-indexer` (#96/#97), `cli-index-command` (#100). The parity run
(#87) is the manual task right after this slice; `own-backend-integration`
(#85) is a parallel branch that has NOT landed — relevant to Q9.

## Decision chain

Q1–Q8 restate resolutions from 2026-08-08, the map (ticket 08), and the
issue-#84 comments. Q9–Q13 are slice-local calls resolved this session.

### Q1 — Where the runner lives

`eval/` in this repo, next to the code it measures — a change to the semantic
module's interface updates the runner in the same PR. The earlier private
data-repo idea is dead: it required importing the semantic module externally
(git dep / npm link), which is exactly the complexity that blocked the harness
for months. The runner does NOT run in CI — it needs a live vault and a built
corpus; it is a local command. (Its code still passes the repo gates — see
Q11.)

Results go to `eval/results/` in this repo, **gitignored**: reports are
machine-generated and tied to a git SHA — noise in the vault's auto-backups,
history is local. Durable numbers (the SC baseline from the parity run) get
recorded in the vault task note and in the design/ADR of the SC-removal
change — by hand, not by the runner.

### Q2 — Golden set: location and format

`<vault>/.neuro-vault/eval/golden.yaml`. The dot-path is auto-excluded from
indexing by the always-excluded-dot-paths rule (ticket 04 / vault-scope), so
no exclusion config is needed; it is committed to the **vault's** git repo
(the vault's `.gitignore` covers only `.neuro-vault/corpus/`). Accepted minus:
Obsidian does not show dot-folders — golden.yaml is a hand-edited YAML for an
external editor, not a note.

Format — YAML, one file, a manually-curated artifact (comments, Cyrillic,
hand edits), not an ML pipeline:

```yaml
- id: q001
  query: "чому release тільки з main"
  lang: ua          # slice for the bge-micro-v2-and-Ukrainian hypothesis
  source: 2026-W20  # which session it was mined from
  relevant:
    - Reflections/release flow.md
```

Relevance is a **binary set**: query → 1..N relevant notes, a hit on any
counts. Strict top-1 was rejected (a "different but relevant" note becomes a
false failure; at n≈30 noise eats the signal); graded/NDCG is overkill — a
binary set is a degenerate graded set, upgrading later is painless.

Curating the golden set itself is issue #86 — a manual task, out of scope
here. The harness ships with test fixtures, not the real golden set.

### Q3 — Runner interface

The runner measures a ranking pipeline behind the interface
`(query) => ranked note paths` — imported as a library, no MCP, no running
server. Invocation: `--vault <path>` (the same convention as the server and
`neuro-vault-mcp index`); the golden set is found at the fixed conventional
path — `NEURO_VAULT_EVAL_DATA` is killed, no config.

### Q4 — Two orthogonal axes: `--pipeline` × `--backend`

Terminology fixed by the map (ticket 08):

- **pipeline** = ranking method: `semantic` | `fused` (later `reranked`).
- **backend** = vector source: `sc` (Smart Connections `.smart-env` corpus)
  | `own` (`.neuro-vault/corpus/` shards).

They are orthogonal: the diagnostic parity run (#87) is the same pipeline
across two backends. `--backend` lives only until SC removal (#88) and dies
with it. The JSON report records both.

### Q5 — v1 scope: `semantic` + `fused` immediately

`fuseRanks` has been importable since 15.0.0 and weight re-tuning is one of
the two customers; the fused leg is one function call — no reason to defer.

### Q6 — Scoring: threshold 0, top-10, positions only

The semantic run uses **threshold 0, top-10**: production thresholds
(0.5/0.35) are calibrated to one model's similarity scale, and scales of
different models are incomparable — eval counts only rank positions. Metrics:
**precision@3, MRR, hit@3**; slices **overall / UA / EN** (from `lang`).

### Q7 — JSON report

Each run writes a JSON report into `eval/results/` carrying: code **git SHA**,
**`vault_sha`** (issue-#84 comment, 2026-08-25: the golden set is measured
against a live vault that is itself in git — same vault SHA → two reports are
mechanically comparable, different → they are not; the harness is a paired-
comparison instrument on one vault state, not an absolute ruler across time),
**model id**, **pipeline**, **backend**, and **config** (RRF weights, leg
pools, thresholds — whatever parameterized the run), plus the per-query and
aggregate metrics.

### Q8 — Golden-set validation at startup

Issue-#84 comment (2026-08-25): notes move (the harness's own task note moved
to `Archive/` during this effort). A broken `relevant` path = a query that
silently became unwinnable — the metric degrades with no real retrieval
degradation. The runner validates at startup that every `relevant` path
exists in the vault and **fails with a non-zero exit** naming the broken
entries — a "compile error" for the golden set.

### Q9 — Own-backend snapshot adapter: `eval/`-local *(this session)*

`--backend own` needs the shard corpus as a `Map<string, SmartSource>`.
`own-backend-integration` (#85) — the production version of exactly that
seam — has not landed and is a parallel branch. The harness builds its own
small adapter (**`CorpusStore.listShards()` + `decodeVector` → `SmartSource`
map**) and keeps it inside `eval/`, not `src/`: promoting it into `src/`
would preempt #85's design (backend contract, promotion, status) with none
of its obligations. If #85 finds it reusable, promotion is its call.

### Q10 — Fused-pipeline configuration *(this session)*

The fused pipeline mirrors the production hybrid path at **deep-effort pool
sizes** (semantic pool 8, lexical `noteCap` 10, expansion active with its
production floor 0.35 and weight 0.85), except the semantic leg runs at
**threshold 0** (Q6's positions-only rationale — production thresholds are
model-scale-bound, and the harness compares across backends/models). Legs
reuse production code: `executeRetrieval`, `LexicalIndex.search` (with the
real `WikilinkGraphIndex` for its backlink tie-break), `flattenExpansion`,
`fuseRanks` with `totalNotes` from the lexical index — the fused order is
exactly `assembleUnified`'s order. Every one of these values is recorded in
the report's `config`, so a run with different knobs is distinguishable.

### Q11 — Invocation and repo gates *(this session)*

npm script **`eval`** → `tsx eval/run.ts` (tsx is already the `dev` runner).
`eval/` is added to `tsconfig.json` `include` — that makes `npm run
typecheck` authoritative for it and puts the files under the type-aware
eslint projectService, so the standard gates (`npm test`, `eslint .`,
`tsc --noEmit`) cover the harness code with zero special-casing.
`eval/results/` goes into this repo's `.gitignore`.

### Q12 — One PR *(this session)*

Single PR. The runner, metrics, report and fixtures are one cohesive
deliverable (~a handful of files under `eval/` + config touches); there is no
independently-shippable foundation half worth pausing on.

### Q13 — Testing *(this session)*

Unit tests with fixtures: metrics math (precision@3/MRR/hit@3 on known
rankings), golden-set parsing + validation failure modes (broken path →
non-zero exit), report shape (axes + SHAs + config present), own-backend
adapter decoding. The pipelines themselves are production code already under
test; the harness tests cover the glue, not re-test retrieval. Runner
end-to-end against a synthetic mini-vault fixture where practical.

## Design trade-offs

- **Runner-in-repo vs data-privacy.** The golden set (real queries, real note
  paths) lives in the private vault, not in this public repo — the repo gets
  only synthetic fixtures. The runner code is public; the data never is.
- **Threshold 0 vs production fidelity.** The fused eval run is NOT
  bit-identical to a production `search_notes` call (which applies 0.5/0.35
  thresholds + fallback). Deliberate: eval must survive model changes, and
  positions are the only cross-model-comparable signal. The cost — eval can
  rank a note production would have filtered — is accepted and recorded in
  `config`.
- **Paired comparisons, not absolute history.** `vault_sha` makes
  comparability explicit instead of pretending reports are comparable across
  vault states. Longitudinal tracking is out of scope by design.
- **`eval/`-local adapter vs sharing with #85.** Slight duplication risk
  accepted to keep this slice from preempting a parallel change's design.

## Still open (deliberately, for later)

- Golden set curation to ≥20 queries with the UA slice — issue #86, manual.
- The diagnostic parity run itself and recording the SC baseline — issue #87.
- `reranked` as a third `--pipeline` value — blocked on the reranker research
  task; the axis is designed to take it.
- Per-leg metrics / anti-discriminative cases (from the threshold-split task
  note) — a future golden-set + runner extension, not v1.
