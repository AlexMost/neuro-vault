# Verification Report: operations-tests-through-gate

> Run: 2026-08-30, after PRs #117/#118/#119 merged and the group-4 doc commits landed on `docs/gate-contract-adr`.

## Summary

| Dimension    | Status                                                            |
| ------------ | ----------------------------------------------------------------- |
| Completeness | 32/32 tasks complete; 3/3 requirements implemented                |
| Correctness  | 13/13 scenarios covered                                           |
| Coherence    | D1–D6 all followed; no deviations                                 |

## Completeness

All tasks in `tasks.md` are checked. Spec coverage, with implementation evidence:

- **`read_notes` selects body granularity via a `content` mode** — `src/modules/operations/tools/read-notes.ts:33-34` declares `paths: z.union([z.string().min(1), z.array(z.string()).min(1).max(50)])` and `content: z.enum(['full','preview','frontmatter']).optional()`, which is the requirement's "enforced by the tool's declared input schema at the registration gate" clause. `validateReadNotesInput` is gone from the tree.
- **The tolerant boundary applies uniformly to every registered tool** — `src/lib/tool-registry.ts:40` wraps every registration with `wrapSchemaWithCoercion`; there is no per-tool bypass, and `src/server.ts:160` registers only from `ToolRegistration` objects produced by it.
- **A `vault` argument is an unknown key in single-vault mode** — `src/lib/vault-param.ts:18` returns `{}` when `!registry.isMulti()`, and the `.strict()` at `src/lib/input-coercion.ts:189` turns the resulting undeclared key into a rejection. Fourteen test files carry the single-vault `vault` case.

## Correctness

All 13 scenarios across the two delta specs are covered. The controlling evidence is structural rather than per-scenario: all 36 surviving `INVALID_ARGUMENT` assertions in `test/operations/tools/` and `test/semantic/tools/` now run on the far side of `callTool`. Were any of those inputs schema-rejectable, the gate would return `INVALID_PARAMS` and the assertion would fail. "No test asserts an error code the gate makes unreachable" is therefore enforced by construction. The survivors are all genuine semantic faults: path traversal, empty filter object, whitespace-only query, and the `INVALID_FILTER` → `INVALID_ARGUMENT` mapping.

The four acceptance conditions from `design.md` §"Migration Plan":

- `npm test` (106 files / 1 333 tests), `npm run lint`, `npm run typecheck`, `npm run format`, `openspec validate --all` (24/24) — all pass.
- `grep -rn '\.handler(' test/operations/tools/ test/semantic/tools/` → two hits, `test/operations/tools/edit-note.test.ts:167` and `:178`, both commented and both with the `CallToolResult` envelope as their subject.
- No test asserts an unreachable error code (see above).
- `grep -rn "validateReadNotesInput\|VALID_CONTENT_MODES" src/ test/` → no matches.

## Coherence

D1–D6 all followed. D5 in particular: the record went to ADR-0015 plus the two existing architecture pages, with no new `docs/architecture/` file, so the registration concept stays in exactly one file as `docs/architecture/README.md` requires.

The five files in the two tool suites that do not import the gate helpers are all legitimately exempt: four fixture/helper modules (`_helpers.ts`, `_test-registry.ts`, `_calibration-fixture.ts`, `_hybrid-helpers.ts`) and `test/semantic/tools/index.test.ts`, whose subject is the `buildSemanticTools` aggregator rather than any tool invocation.

## Issues

**CRITICAL**: none. **WARNING**: none.

**SUGGESTION (1)** — the `tolerant-arguments` requirement "Every tool reachable by an MCP client SHALL have its declared input schema wrapped … and MUST NOT rely on any per-tool exemption" is a structural property no source-level test observes. It holds today because `registerTool` is the only registration path, but nothing fails if a future tool registers around it. `design.md` §"Open Questions" already defers mechanical enforcement (a lint rule or CI grep) to its own change, with a stated rationale. Recorded here so the deferral stays visible past archive rather than dissolving into it.

## Assessment

No critical issues, no warnings. Ready for archive.
