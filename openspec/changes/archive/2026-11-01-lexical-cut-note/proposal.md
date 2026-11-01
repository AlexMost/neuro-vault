Tracked by: #266

## Why

`truncated` is true on 84–98% of hybrid deep calls in the agent A/B (PR #263), so agents read
it as noise and stop. In the clearest case `query_stats` said the exact term matched 14 notes
lexically, the result showed 0–3, and the agent stopped after one call in five of six runs. The
loss happens at retrieval: 49% of the small vault's single-token golden notes never reached the
agent. Plain-string queries (12–19% of calls) get no `query_stats` at all.

## What Changes

**`query_stats` for every query**
- From: present for array queries only.
- To: present for every query; a plain string is one entry keyed by the normalized query.
- Reason: a total to read "k of N" against.
- Impact: additive field on string-query responses.

**The cut note**
- From: a `query_stats` entry carries a `note` only for a dead variant or a fallback retry.
- To: an entry also carries a `note` when fewer of the variant's lexical matches reached
  `matches[]` than it had (N), and N is at most 50:
  `"X" matched N notes lexically, k shown. For all of them: search_notes({ query: "X", mode: "lexical", limit: N }).`
  With a filter on the call, the suggested call says to keep it.
- Reason: names the one call that recovers what this response cut, which works since #264.
- Impact: additive `note` value.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hybrid-search`: "query_stats reports pre-cap per-query hit counts" covers string queries and
  adds the cut note.

## Impact

- Code: `src/modules/semantic/retrieval-pipeline.ts` (`perQueryShown` on the lexical outcome),
  `src/modules/semantic/search-observability.ts`, `src/modules/semantic/tools/search-notes.ts`
  (output type, one description line).
- Contract: additive. No input change, no new error code.
