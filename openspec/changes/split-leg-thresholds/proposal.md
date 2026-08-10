## Why

`search_notes` advertises `threshold` as "SEMANTIC LEG ONLY. Default 0.5 (quick) / 0.35 (deep)". In reality one shared threshold reaches three legs on three incomparable similarity scales, and a silent fallback retry at 0.3 cancels any explicit threshold that filters out all semantic hits. A 2026-08-10 calibration showed the knob visibly cutting the expansion leg (note↔note scale 0.89–0.985) while the semantic leg returned identical results at every tested value — the current `hybrid-search` spec ("`threshold` SHALL affect only the semantic leg") is violated by the implementation, and the tool doc actively teaches wrong usage to the model.

## What Changes

**Explicit threshold vs silent fallback**
- From: on zero semantic hits with `threshold > 0.3`, the search silently retries at 0.3 — an explicit threshold is unenforceable.
- To: the fallback retry runs only when `threshold` was not explicitly provided; an explicit `threshold` is a hard filter. When the default-threshold fallback does engage, the response surfaces that fact (via `query_stats`) instead of staying silent.
- Reason: an explicitly requested filter must filter; silence made the bug invisible since the parameter's introduction.
- Impact: behavior change only for callers passing explicit `threshold` (previously a de-facto no-op above the hit band); default calls unchanged.

**Expansion leg gets its own floor**
- From: the expansion leg (`computeRelatedPerSeed`) is filtered by the same `threshold` value — the only place the knob visibly bites, on a scale where the semantic defaults (0.5/0.35) never engage.
- To: a new optional contract parameter (working name `expansion_floor`, note↔note scale) with a behavior-preserving default; `threshold` no longer reaches the expansion leg.
- Reason: the scales are incomparable; sharing one knob is what produced the inversion-looking bug.
- Impact: non-breaking (new optional parameter, default preserves current output).

**Block filtering decoupled from user threshold**
- From: in deep mode, block evidence inside seed notes is filtered by the user `threshold` (query↔block scale), with a 1-block-per-seed backfill.
- To: `threshold` applies to the note score only; deep block filtering uses the internal mode default (0.35). The backfill guarantee is unchanged.
- Reason: removes the third incomparable scale from under the same knob.
- Impact: non-breaking in defaults; explicit-threshold callers get richer, more consistent block evidence.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hybrid-search`: `threshold` becomes an honest semantic-leg-only hard filter (fallback restricted to default thresholds and surfaced in `query_stats`); new optional `expansion_floor` input axis for the expansion leg; per-seed block evidence no longer shaped by the user `threshold`.

## Impact

- Code: `src/modules/semantic/retrieval-policy.ts` (fallback condition, `computeRelatedPerSeed` floor, deep block threshold), `src/modules/semantic/tools/search-notes.ts` (new parameter, threshold plumbing, `query_stats` fallback signal, tool description text).
- Contract: `search_notes` input schema gains one optional parameter; parameter dictionary (`docs/architecture/mcp-parameter-dictionary.md`) gains its entry (ADR-0005: name is permanent).
- Docs: tool description doc-string, `docs/` sweep including the model-facing guide layer.
- Tests: SDK-gate tests for the new parameter and corrected threshold semantics (assert via `reg.spec.inputSchema`, not handler-direct); regression tests pinning the 2026-08-10 calibration curve onto the new parameter.
- External tracking: vault task "Розділити пороги легів" (source of decisions); ranking-quality and default-recalibration follow-ups live in the Retrieval eval harness task, out of scope here.
