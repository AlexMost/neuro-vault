# Retrospective: lexical-cut-note

## 0. Evidence

- Tracked by #266, part of epic #267. One PR, built on #264 (merged) and #265.
- Gates and the agent-level check: `verify.md`.
- Review: one subagent over the whole diff, no blocker. Fixed: two spec requirements still
  scoped `query_stats` to arrays, the suggested call dropped a pinned `vault`, and the filter
  placeholder sat inside the call text.

## 1. Wins

- The note needed no new pipeline pass: `perQueryShown` is one loop over the candidates the
  pipeline already returns, and `deriveObservability` stayed pure over records.
- `query_stats` for string queries was a deletion (the `isMulti` branch), not an addition.
- The description got shorter, not longer: the guidance rides on the responses it applies to
  (ADR-0010).

## 2. Misses

- The first delta spec modified only the `query_stats` requirement. Two other requirements also
  said "array queries only" and would have contradicted the new contract after archive. Review
  caught it. Before writing a delta, grep the whole spec for the phrase being changed.
- The first draft put `filter: <the same filter>` inside the suggested call. An agent pastes
  calls verbatim; anything that is not valid input belongs outside the call text.

## 3. Plan deviations

- The note names the call's `vault` when the call pinned one (added in review).
- The agent-level check ran once over the epic's combined code (#264 + #265 + #266), not per
  change: the epic's done-when cell measures them together, and a rerun per PR would have
  tripled the cost.

## 4. Skill / workflow compliance

- Artifacts written by hand in the schema's shape, in the change directory; validated with
  `openspec validate`.

### Deliberately Skipped Skills

- `superpowers:subagent-driven-development`: the change is small enough for one TDD pass in
  the main session; one review subagent covered the whole diff.

## 5. Surprises

- Under the weighted RRF of #265, a variant's own lexical notes can be in the pool while lower in
  the fused list. `perQueryShown` counts what reached `matches[]`, which is what the agent
  sees, so the note stays honest either way.

## 6. Promote candidates → long-term learning

- When a contract field changes scope ("array only" → always), grep the spec and the docs for
  the old scope before writing the delta.
