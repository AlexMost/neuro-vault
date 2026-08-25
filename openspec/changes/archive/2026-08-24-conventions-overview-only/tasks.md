<!--
Parallelism map (for subagent-driven-development):

  Group 1  ── SEQUENTIAL, foundation. Everything else reads the shape it lands.
  Group 2  ── SEQUENTIAL, depends on 1 (asserts the constant 1 produces).
  Groups 3, 4, 5, 6 ── PARALLEL-SAFE with each other once 1 and 2 are green.
                        Disjoint files, no shared state.
  Group 7  ── SEQUENTIAL, last. Whole-repo gates.

Group 4 (docs) touches six files that no other group edits; a subagent may take
one file each. Group 3 (ADR) and group 4 both append to docs/adr/INDEX.md — that
one file is group 3's alone, so group 4 subagents must not touch it.
-->

## 1. Instructions become a vault-independent constant

Sequential. This is the foundation — do not start groups 2–6 until it is green.

- [x] 1.1 Write a failing test in `test/server-instructions.test.ts`: composing instructions for a registry whose vault has a distinctive `for-external-agents.md` yields a string containing none of that file's content. Confirm it fails against the current implementation before touching `src/`.
- [x] 1.2 Write a failing test that instructions composed for a single-vault registry and for a multi-vault registry with differently-sized conventions files are byte-identical.
- [x] 1.3 Write a failing test that the composed string contains the literal `get_vault_overview` in a statement that conventions are delivered there, and that this holds when no vault has a conventions file.
- [x] 1.4 Draft the pointer paragraph and append it to `STATIC_SERVER_INSTRUCTIONS` in `src/server.ts`. Content is fixed by the spec: it names `get_vault_overview`, says conventions arrive there rather than in `instructions`, and says to call it before reading/writing/organising notes. Target ~240 characters (design D4 measured 693 + 241 = 936).
- [x] 1.5 Replace `export async function buildServerInstructions(registry)` with an exported string constant (design D3). Delete the per-vault composition loop, the `readVaultConventions` import, and the `IVaultRegistry` dependency it created.
- [x] 1.6 Update the `STATIC_SERVER_INSTRUCTIONS` doc comment: it currently claims the preamble is "sized to fit in what is left" ahead of a conventions block that no longer exists. State the new invariant instead — a constant, under 2048, independent of vault configuration — and record the non-goal that the freed budget is not to be spent (design "Non-Goals").
- [x] 1.7 Update the call site in `startNeuroVaultServer` to pass the constant directly, with no `await`. Confirm `npx tsc --noEmit` is clean — it is authoritative here, not `tsup` (ADR-0002).
- [x] 1.8 Confirm tests 1.1–1.3 now pass.

## 2. Collapse the budget and ordering suite

Sequential, depends on group 1.

- [x] 2.1 Add the unconditional budget assertion to `test/server-instructions.test.ts`: the composed string is under 2048 characters for any registry. This replaces the old fixture-pinned guard whose free variable was the vault owner's file (design D5).
- [x] 2.2 Delete the conventions-ordering tests — the ones asserting a conventions block starts at a lower offset than server prose, and that a ~1,200-character fixture survives inside 2048. Both describe removed behaviour.
- [x] 2.3 Delete the multi-vault conventions block-attribution tests, and the `readVaultConventions`-backed registry fixtures in that file that exist only to feed them.
- [x] 2.4 Confirm the file no longer imports `readVaultConventions`, and that `npm test` passes for this file alone before moving on.
- [x] 2.5 Confirm the overview-channel conventions tests still pass untouched: `test/lib/obsidian/vault-overview.test.ts`, `test/lib/obsidian/vault-conventions.test.ts`, `test/operations/tools/get-vault-overview.test.ts`, `test/operations/resources/vault-overview.test.ts`. If any needed an edit, stop — the change has leaked past its scope.

## 3. ADR-0012

Parallel-safe with groups 4–6. Owns `docs/adr/INDEX.md`; no other group may edit that file.

- [x] 3.1 Write `docs/adr/0012-<slug>.md` from `docs/adr/0000-template.md`, status Accepted. Record that duplicating owner content into `instructions` measured net-negative: the per-server (not per-vault) cap, the preamble dying above ~1,316 characters, the asymmetric CI guard, and the absent truncation signal. Carry the measurement table from design "Context".
- [x] 3.2 State the relationship to ADR-0010 explicitly (design D2): this applies ADR-0010's rule rather than reversing it — conventions entered under "no description can supply another vault's rules", true of the text and false of the pointer. Do not amend ADR-0010; ADRs are immutable (ADR-0008).
- [x] 3.3 Record the accepted cost and the non-goal: an owner loses the no-tool-call path, and the freed ~1,300 characters are headroom rather than an allowance for preamble growth.
- [x] 3.4 Add the ADR-0012 row to `docs/adr/INDEX.md`, matching the existing row format.

## 4. Documentation sweep

Parallel-safe with groups 3, 5, 6 — and internally parallel: six disjoint files, one per subagent. None of these tasks touches `docs/adr/INDEX.md` (group 3 owns it).

- [x] 4.1 `README.md` — delete the `instructions`-delivery bullet and the "one clearly-labelled block per vault" sentence outright (design D6); there is no honest rewrite. Leave the overview-channel bullet as the single documented delivery path, and keep the 8,000-character guidance, which correctly describes that channel.
- [x] 4.2 `docs/architecture/vault-conventions.md` — remove the two-channel framing and the `instructions`-channel section, including the description of the 1,227-character fixture guard. Restate the cap as the overview channel's own (design D7). Fix the closing notes that reference the ordering rule as the `instructions` budget's protection.
- [x] 4.3 `docs/architecture/mcp-server-shape.md` — `buildServerInstructions(registry)` no longer composes anything at startup; describe the constant. Update the hand-off sentence that delegates "per-vault conventions blocks" to `vault-conventions.md`.
- [x] 4.4 `docs/architecture/vault-registry.md` — fix the dataflow diagram line that shows `buildServerInstructions(registry)` producing per-vault conventions blocks. Keep the `readConventions` per-vault-capability paragraph: it stays load-bearing for `get_vault_overview` and the `vault://overview` resource.
- [x] 4.5 `docs/architecture/obsidian-lib.md` — `vault-conventions.ts` is shared by the overview payload only; drop `buildServerInstructions` from its consumer list and from the registry-wiring paragraph.
- [x] 4.6 `docs/guide/configuration.md` — remove the sentence describing the same text placed at the front of `instructions`. Add the verification footnote: in Claude Code, `/mcp reconnect` does not rebuild the session's system prompt, so a changed `instructions` string is only observable in a fresh session.
- [x] 4.7 Re-read the `CONVENTIONS_CHAR_CAP` doc comment in `src/lib/obsidian/vault-conventions.ts`, which contrasts the cap with "the MCP `instructions` channel". Reword if the comparison now misleads; leave the constant and its value alone (design D7, and design "Open Questions" flags this as a reading call).

## 5. Repo-wide claim sweep

Parallel-safe with groups 3, 4, 6. Read-only until it finds something, and it must not re-edit files group 4 owns — report those to group 4 instead.

- [x] 5.1 Grep the whole repo (`docs/`, `README.md`, `src/`, `test/`, `openspec/`) for `instructions` near `conventions`, and for `8,000` / `8000`, to catch claims outside the six files named above. A doc sweep scoped to `docs/architecture/` alone misses the guide layer — cover all of `docs/`.
- [x] 5.2 Grep for `buildServerInstructions` and confirm every remaining reference in prose and code matches the constant's new shape.
- [x] 5.3 Verify the acceptance claim directly: no doc asserts a per-vault `instructions` block, and no doc offers 8,000 as a budget for the `instructions` channel.

## 6. Issue and spec bookkeeping

Parallel-safe with groups 3, 4, 5.

- [x] 6.1 Re-run `npx openspec validate --all` and confirm the change and every spec still pass.
- [x] 6.2 Confirm the delta's four MODIFIED headers and one REMOVED header still match `openspec/specs/vault-conventions-delivery/spec.md` verbatim — archive applies MODIFIED by full-text replacement, so a drifted header fails there rather than here.

## 7. Gates and delivery

Sequential, last. Nothing else may be in flight.

- [x] 7.1 Run `npm test`, `npm run lint`, and `npm run typecheck` — all three must pass (AGENTS.md). Run the lint gate's verbatim command, not a path-scoped subset.
- [x] 7.2 Run `npm run build` to match what CI enforces.
- [x] 7.3 Verify the four acceptance criteria from the tracking issue against actual command output, not inference: gates pass; no conventions content in composed `instructions` for single- or multi-vault registries; composed `instructions` under 2048 unconditionally; no doc claiming a per-vault block or an 8,000-character `instructions` budget.
- [ ] 7.4 Push the branch and open a PR to `main` with `gh pr create`, carrying `Closes #93`. Never push to `main` directly; release happens separately on `main` after merge.
