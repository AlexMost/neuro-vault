# Brainstorm — retrieval-outcome-records

Tracked by: #110 (folds in the unfinished tail of #109).

This change was started from an architecture review rather than an open conversation, so the
brainstorm is a decision log: the starting brief fixed scope and target shape, and the forks
below were settled against the code. Calls made here (rather than in the brief) are marked
**(builder's call)**.

## Background

An architecture review on 2026-10-19 (main at d23422a, v17.2.0) rated "make the retrieval
pipeline own leg outcomes, derive observability in one place" as worth exploring. History:

- #109 asked to extract the retrieval pipeline from `search_notes`. PR #125 landed
  `src/modules/semantic/retrieval-pipeline.ts` and `effort-profiles.ts`, but the tail never
  landed: eval still calls `executeRetrieval` + `fuseRanks` directly, the drift pin
  `test/eval/production-fusion-pin.test.ts` still exists to catch the two copies diverging,
  `effort-profiles.ts` admits in a comment that eval restates its numbers, and
  `docs/architecture/rank-fusion.md` still describes `assembleUnified`.
- #110 asked to derive `search_notes` observability from leg outcome records. Still open.

Evidence on main (2026-10-19):

- `search-notes.ts` has two return sites: the empty-filter early return and the success path.
- `buildQueryStats` takes 9 fields; `semanticRan` / `lexicalRan` exist only to say which exit
  is calling, and the early return passes four empty placeholders.
- `semantic_status` is re-derived after the pipeline from its semantic outcome (the failure
  override: `CorpusNotReadyError` carries its status, anything else is `unavailable`).
- `SemanticLegOutcome` already is the outcome record #110 asks for. The lexical leg has no
  equivalent; the pipeline returns a bare `{ perQueryCounts, perQueryTokenCounts, totalNotes }`
  and folds every leg's pool truncation into one `truncated` boolean.
- `query_stats` policy is testable only through the tool: the `query_stats` describe blocks in
  `test/semantic/tools/search-notes-hybrid.test.ts` each build a temp vault, registry stub and
  embedder mock.
- Deletion test: `buildQueryStats` / `queryStatsNote` are pass-through shaped — their interface
  is as wide as their implementation. Deleting them only moves complexity. The deep module is
  the pipeline with symmetric outcome records, plus one pure deriver.

## Scope

In: symmetric leg outcome records on `runRetrievalPipeline`; one pure deriver for
`semantic_status` / `query_stats` / `truncated` and the degradation warning; `search_notes`
down to one return; eval's fused pipeline invoking `runRetrievalPipeline`; `EVAL_CONFIG`
reading `EFFORT_PROFILES`; drift pin deleted; spec deltas; docs swept. Also the ADR-0015
pass-throughs on the semantic side (`readThreshold`, `readPositiveInteger`, the duplicated
`wrapDependencyError`) as a preparatory PR, since it rewrites the same files.

Out: any tool-contract change (input/output schema, parameter names, envelope, any note
sentence); retuning any number; anything outside the semantic module and eval (other
sessions own the backend, lexical, daemon, vault-entry, registry, server and CLI files).

## Decisions

### Q1 — Does the lexical outcome get a `failed` variant?

No **(builder's call)**. The lexical leg is the floor a semantic failure degrades to, so its
failure fails the vault's search outright (`DEPENDENCY_ERROR`, spec "a lexical leg that fails
is a dependency error"). A response is never built over a failed lexical leg, so there is
nothing to derive from a `failed` record. Adding one would oblige every caller to check and
rethrow it — a pass-through. `runRetrievalPipeline` keeps throwing `LexicalSearchError`, as
it does today. The lexical outcome is `skipped | ran`.

### Q2 — How does the empty-filter early return reach the single return?

The pipeline owns it. An `allowed` set of size 0 short-circuits inside `runRetrievalPipeline`:
both outcomes `skipped`, no candidates, nothing truncated, no lexical read, no embedding.
"Which legs ran" then has one owner, and the tool's early return disappears. The
short-circuit only changes where the decision is made — today's early return reads neither
leg either.

Side effect to keep: today the early return also skips `graph.ensureFresh()`. The session
graph only feeds `backlink_count` stamping, so the first idea was to move `ensureFresh()` after
the pipeline. Apply showed that changes behaviour: a refresh that throws fails the vault before
any leg runs (in a fan-out it lands in `failed_vaults`), and after the move a vault with no
candidates would succeed instead. So `ensureFresh()` stays before the pipeline, skipped for an
empty `allowed` set exactly as before **(builder's call, revised during apply)**.

### Q3 — Where does `truncated` get computed?

Each leg's outcome carries its own pool truncation (`truncated` on `ran`); the pipeline result
keeps a top-level `truncated` that means only "the merged cap cut the fused list". The deriver
ORs the three. That puts "what survived" next to the leg it describes, and gives the deriver
the whole `truncated` rule rather than a value to forward **(builder's call)**. The reported
boolean is identical: `fused.length > cap || lexical.truncated || semanticTruncated` today.

### Q4 — What exactly is the deriver's input and output?

`deriveObservability(outcomes, context)`:

- `outcomes`: `{ semantic, lexical, truncated }` — the pipeline result minus candidates.
- `context`: `{ pinnedStatus, queries, isMulti, fallbackThreshold, vault }`. `pinnedStatus` is
  the `BackendStatus | undefined` read once up front (design D5 of the semantic-status work);
  the deriver maps it, so `toStatusField` and `DEGRADED_NOTES` move with it.
- Output: `{ semantic_status, query_stats?, truncated, warning? }`. `warning` is the stderr line
  for a semantic leg that failed and degraded; a pure function cannot write to stderr, so the
  tool writes what it is handed. `vault` is in the context only for that sentence.

The degradation branch reads `error instanceof CorpusNotReadyError` — a pure check on data the
record carries.

### Q5 — Where does the deriver live, and who owns the payload types?

`src/modules/semantic/search-observability.ts`. It owns `SemanticStatusField` and the
`query_stats` entry type; `search-notes.ts` imports them for `SearchNotesOutput` and keeps
exporting `SemanticStatusField` from where tests import it today. No import cycle: the deriver
never imports the tool.

### Q6 — Which tests move, which stay?

Replace, don't layer. Pure tests for the deriver (every `semantic_status` mapping, every
`query_stats` note sentence asserted byte-for-byte, `truncated`, the warning) and for the
pipeline's outcome records (lexical `ran` counts and pool truncation, empty-allowed
short-circuit, pre-cap counts surviving the merged cap) replace the through-the-tool tests
whose subject is that policy. Through-the-tool tests stay where their subject is wiring: one
hybrid `query_stats` end-to-end, the empty-filter path, the degradation paths (they also
assert the stderr warning), status pinning, lexical-mode not reading the corpus. The
`semantic_fallback` flag's correctness is the retrieval policy's (`retrieval-policy.test.ts`
already pins `per_query_fallback`), and the token counts are the lexical index's
(`rank.test.ts`, `lexical-index.test.ts`), so the tool-level copies of those go.

### Q7 — Eval wiring (PR 3)

`rankFused` calls `runRetrievalPipeline` with `effort: 'deep'`, `threshold: 0`, the profile's
`expansionFloor`, `cap` = top-k, a standalone lexical reader and an existence filter that
admits everything (eval ranks the corpus as loaded). `EVAL_CONFIG` reads `EFFORT_PROFILES.deep`
and `LEXICAL_PER_NOTE_CAP` instead of restating 8 / 10 / 3 / 3. With one code path the drift
pin has nothing left to compare, so it is deleted; the `retrieval-eval` spec's "Standalone
library execution" requirement is reworded to say the fused pipeline invokes the shared
module. Eval metrics must be unchanged within noise — before/after recorded in verify.md.

Watch items, read off `eval/pipelines.ts`:

- `cap`: the pipeline slices the fused list at `cap`; eval scores top-10 and today takes the
  first 10 of the full fused list, so `cap: EVAL_TOP_K` is equivalent.
- `score`: eval reports each ranked path's fused score; `PipelineCandidate` carries none. The
  pipeline gains a `score` on each candidate (search_notes ignores it) **(builder's call)**.
- Existence filter: eval does not existence-check (it ranks the corpus as loaded); it passes
  an admit-all `filterExisting`, which keeps today's ordering.
- Explicit pool knobs: eval passes `limit: 8` / `expansionLimit: 3` explicitly; the pipeline
  takes them from `EFFORT_PROFILES.deep` via the retrieval policy's mode defaults. Same values,
  one source; `config` in the report reads the same file, so it still tells the truth.

## Delivery

1. Preparatory direct PR (`Refs #110`): ADR-0015 pass-throughs out.
2. Foundation PR (`Refs #110`): outcome records + deriver + one return + pure tests, with
   these artifacts. Stacked on PR 1 (same files). Pause after opening it.
3. Eval + pin + spec sync + docs sweep, verify, retrospective, archive (`Closes #110`,
   `Closes #109`).

## Promotion check

1. Scope locked — yes (above).
2. Forks resolved — Q1–Q7.
3. Dependencies — none external; the lexical reader and corpus seams are read-only here.
4. Acceptance — four gate commands green; payloads byte-identical on existing scenarios;
   eval metrics unchanged; drift pin gone.
5. Converging — the brief is the approval; no open alternatives.
