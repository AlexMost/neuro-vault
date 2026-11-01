# Brainstorm — lexical-cut-note

Tracked by: #266. Part of epic #267. Blocked by #264 (merged).

## The problem in one line

`truncated` is true on almost every `search_notes` call, so it cannot tell "nearly everything"
from "3 of 14", and plain-string queries carry no `query_stats`, so there is no total to compare
against. Agents stop after a truncated result in 72–81% of runs (A/B of PR #263).

## Options weighed

1. **Make `truncated` richer (`{ by, fix }`).** Breaks a field released in 15.5.0. Rejected.
2. **Put the advice in the tool description.** Paid on every `tools/list`; the case is per-call.
   Rejected by ADR-0010: per-call guidance rides on the response.
3. **A per-variant `note` on `query_stats` when that variant's lexical matches were cut.**
   Additive, lands only on the responses it applies to, and names the exact recovering call,
   which works since #264 (the lexical pool follows `limit`). Chosen.

## Forks resolved

- **What "cut" means.** Fewer of the variant's lexical notes reached `matches[]` than its pre-cap
  lexical count. Counted from the pipeline's final candidates (`perQueryShown`), not inferred.
- **Ceiling.** 50. Above it the variant is too broad to read in full, and a note on every broad
  variant would be the new `truncated`.
- **Precedence.** After the dead-variant notes (a dead variant has `lexical: 0`, so they never
  collide), before the fallback note: the cut note recovers notes, the fallback note only grades
  them.
- **Filter.** The suggested call must keep the call's filter, or it returns a different set. The
  note says `filter: <the same filter>` rather than echoing the filter back.
- **Multi-vault.** No `vault` in the suggested call: fan-out returns up to `limit` per vault, so
  it still fetches all of them.
- **Plain strings.** `query_stats` gets one entry keyed by the normalized query. `matched_queries`
  stays array-only: with one query it says nothing.

## Out of scope

Paging (`offset`/`cursor`), changing `truncated`, a hint for the semantic leg.
