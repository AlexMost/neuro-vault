## Context

An MCP server has three channels for putting text in front of an agent: the `instructions` string returned at `initialize`, each tool's `description`, and each tool's response. ADR-0010 established that descriptions and responses are the only two that arrive intact, and that `instructions` is best-effort — populated, ordered so the most irreplaceable content leads, but never load-bearing.

Under that rule, a vault owner's `.neuro-vault/for-external-agents.md` was routed down **two** channels:

- the **overview channel** — a `conventions` field on the `get_vault_overview` response and the `vault://overview` resource, read fresh at call time;
- the **`instructions` channel** — `buildServerInstructions(registry)` reads every registered vault's file at startup and emits one block per vault, ahead of the 693-character server preamble.

The duplication was accepted deliberately: a client that renders `instructions` uncapped would get the conventions without a tool call. ADR-0010 records that Cursor and Windsurf were never measured.

**Current state, measured.** Claude Code truncates `instructions` at 2048 characters **per server**, not per vault. Because conventions are emitted first, the cut lands on the preamble:

| conventions file | composed `instructions` | conventions delivered | preamble delivered |
| --- | --- | --- | --- |
| 223 | 955 | 100% | yes |
| 1,227 *(current test fixture)* | 1,959 | 100% | yes |
| 2,017 | 2,749 | ~100% | **no** |
| 2,813 | 3,545 | 72% | **no** |
| 6,755 | 7,487 | **30%** | **no** |

Constraints that shape the design:

- **The cap is per server.** With two vaults registered, the first consumes the budget and later blocks arrive as nothing — reproduced in both registration orders.
- **The preamble dies first.** Anything over ~1,316 characters of conventions deletes it entirely, contradicting the comment in `src/server.ts` claiming it is "sized to fit in what is left".
- **The CI guard is asymmetric.** `test/server-instructions.test.ts` fixes the conventions fixture at 1,227 characters and varies only the preamble. A vault owner's file is the free variable in production and the pinned constant in CI.
- **The documented guidance points the wrong way.** Docs offer 8,000 characters as the practical budget — that is `CONVENTIONS_CHAR_CAP`, which belongs to the *overview* channel.
- **There is no signal.** The overview channel flags trimming with `conventions_truncated`; `instructions` has no response shape to carry one, so every failure above is silent.

Stakeholders: vault owners who author the conventions file, and MCP clients that consume `instructions`. The change is invisible to every tool contract.

## Goals / Non-Goals

**Goals:**

- Make composed `instructions` a constant — identical for every registry, independent of vault count and of any file on disk.
- Keep the pointer to the vault's conventions in `instructions`, so an agent still learns the conventions exist and where to get them.
- Leave the overview channel bit-for-bit unchanged: `conventions`, `conventions_truncated`, call-time freshness, fan-out attribution, the 8,000-character cap.
- Replace the ordering-and-budget test suite with an invariant no vault owner can break.
- Leave no document claiming a per-vault `instructions` block, and none offering 8,000 as an `instructions` budget.
- Record the decision as ADR-0012, building on ADR-0010.

**Non-Goals:**

- **Growing the preamble into the freed budget.** Cutting conventions frees ~1,300 of the 2048 characters. The preamble stays as it is. Anything a tool can say about itself still belongs on that tool's description; ADR-0010 is being applied here, not relaxed. Headroom is the outcome, not an allowance.
- **Changing `CONVENTIONS_CHAR_CAP`, `capConventions`, or `readVaultConventions`.** All three serve the overview channel and are correct there.
- **Removing `IVaultEntry.readConventions`.** Verified still load-bearing: `src/modules/operations/tools/get-vault-overview.ts:20` and `src/modules/operations/resources/vault-overview.ts:26` consume it. Only the `src/server.ts:61` consumer goes away.
- **Fixing the client.** The 2048-character cap and the absent sub-agent `instructions` are Claude Code behaviours on someone else's release schedule.
- **A startup warning, a truncation signal, or budget-aware multi-vault composition.** Each is patch-work for a channel this change removes conventions from.

## Decisions

### D1: Cut the conventions out of `instructions` rather than patch the channel

- **Choice**: `buildServerInstructions` stops reading vault conventions entirely.
- **Rationale**: Patching requires, at minimum, a startup budget warning, budget-aware composition dividing 2048 across N vaults, a truncation signal on a channel with no response shape to carry one, and a re-ordering rule that stops the preamble being the casualty. That is four mechanisms serving a benefit that has never been measured on any client.
- **Alternatives considered**:
  - *Emit only the first vault's conventions, budget-checked* — still silent when it trims, still leaves later vaults with nothing, and still makes the preamble's survival depend on a file the server does not control.
  - *Reverse the order — preamble first, conventions after* — saves the preamble and dooms the conventions instead. Trades one silent loss for another.
  - *Warn on stderr at startup when the composed string exceeds 2048* — surfaces the problem without fixing it, and stderr is not where a vault owner looks.

### D2: This applies ADR-0010; it does not reverse it

- **Choice**: A new ADR-0012 that builds on ADR-0010 rather than superseding it.
- **Rationale**: ADR-0010 says `instructions` carries only what no tool description can carry. Conventions entered under "no description can supply another vault's rules" — true of the **text**, false of the **pointer**, and `get_vault_overview`'s description already carries that pointer today. Removing the text while keeping the pointer is the ADR-0010 rule enforced, not weakened.
- **Alternatives considered**:
  - *Amend ADR-0010 in place* — rejected: ADRs are immutable under ADR-0008.
  - *Supersede ADR-0010* — rejected: its core finding (descriptions and responses are the reliable channels) is confirmed by this change, not overturned.

### D3: `buildServerInstructions` becomes a module constant

- **Choice**: Replace `export async function buildServerInstructions(registry: IVaultRegistry): Promise<string>` with an exported string constant. `startNeuroVaultServer` passes it to `serverFactory` directly, with no `await` and no registry dependency.
- **Rationale**: With no per-vault content to compose, the function has no inputs. Keeping a zero-argument function would preserve a call shape that implies a computation, and preserve the possibility of that computation growing back.
- **Alternatives considered**:
  - *Keep `buildServerInstructions()` as a zero-arg synchronous function* — rejected: an indirection that models a composition step no longer present.
  - *Keep the registry parameter for API stability* — rejected: the export is internal, consumed by one call site and one test file.

### D4: The pointer line names the channel and the trigger

- **Choice**: Append one paragraph to the existing preamble, of the form: the server's vaults may carry owner-authored conventions (how notes are organised, which folders are off-limits, what `type` values exist); they arrive on the `get_vault_overview` response, not here; call it before reading or writing notes.
- **Rationale**: A bare "conventions exist" does not tell the agent what to do. Naming the tool, and the moment to call it, makes the pointer actionable in the one channel that survives. Exact wording is settled during implementation; the required content is fixed by the spec.
- **Measured**: 693-character preamble + 241-character pointer = **936 characters**, 54% under the 2048 cap, with no dependence on vault configuration.
- **Alternatives considered**:
  - *No pointer at all* — rejected: an owner losing the text should not also lose the signal that a conventions file is worth fetching.
  - *Fold the pointer into the existing scope-discovery paragraph* — rejected: that paragraph answers "how is this project scoped"; conventions answer "how does this vault work". Merging them makes both vaguer to save ~40 characters we do not need.

### D5: The budget test asserts a constant, not a fixture

- **Choice**: Collapse the suite to: the composed `instructions` are a fixed string, under 2048 characters, identical across single-vault and multi-vault registries, and containing no vault-file content. Delete the ordering tests and the multi-vault block-attribution tests.
- **Rationale**: The old suite guarded "a representative file fits", with the representative file pinned in CI and free in production — exactly the asymmetry that let this ship. Asserting a constant removes the free variable rather than choosing a better value for it.
- **Alternatives considered**:
  - *Keep the budget test and add a second one for a large file* — rejected: tests a composition path being deleted.

### D6: Delete the README claim rather than rewrite it

- **Choice**: The bullet describing `instructions` delivery and the sentence promising "one clearly-labelled block per vault" are removed. The overview-channel bullet becomes the single documented delivery path.
- **Rationale**: There is no honest rewrite. The accurate version of that sentence describes a behaviour this change removes.
- **Alternatives considered**:
  - *Rewrite it as "best-effort, first vault only, under ~1,300 characters"* — rejected: documents a caveat lattice instead of removing the cause.

### D7: `CONVENTIONS_CHAR_CAP` stays at 8,000 and gains no note

- **Choice**: The constant and its value are untouched; only prose framing it as `instructions` guidance is corrected.
- **Rationale**: 8,000 was always the overview channel's cap and is correct there. The defect was documentation attaching it to the other channel. Once `instructions` carries no conventions, the number needs no qualification.

### D8: The spec delta removes one requirement and modifies three

- **Choice**: Against `openspec/specs/vault-conventions-delivery/spec.md` — one removal, one addition, four modifications:
  - **REMOVED** — "A vault's conventions survive the instructions truncation budget". Its subject ceases to exist.
  - **ADDED** — "Instructions point at the overview channel for conventions": the new pointer obligation, stated as its own requirement so it is testable independently of what `instructions` excludes.
  - **MODIFIED** — "Composed instructions do not restate tool descriptions": restated so the composed string is a vault-independent constant carrying no vault-file content.
  - **MODIFIED** — "Conventions are read at call time": its trailing clause qualifies the `instructions` channel's staleness. That clause becomes vacuous — and therefore misleading — once the channel carries no conventions at all.
  - **MODIFIED** — "Each vault's conventions travel with that vault": drops the trailing per-vault-`instructions`-block clause; every overview fan-out clause is retained verbatim.
  - **MODIFIED** — "An unreadable conventions file never fails a call": drops the instructions-composition clause; the overview clause is retained.
- **Rationale**: The capability is *conventions delivery*, and delivery still happens — over one channel instead of two. A whole-capability removal would discard the overview requirements, which are correct and unaffected. Splitting the pointer into its own ADDED requirement keeps the exclusion rule ("no vault content, no tool-description restatement") separate from the inclusion rule ("names `get_vault_overview`"), so a regression in either is caught on its own.
- **Note**: MODIFIED deltas are applied by full-text replacement at archive time and must reproduce the existing header exactly, so each is written out in full.

## Risks / Trade-offs

**[Trade-off] An owner relying on conventions reaching the system prompt without a tool call loses that path.**
Accepted. That path is conditional on four things simultaneously: a client that renders `instructions`, a single registered vault, a file under ~1,316 characters, and a main agent rather than a sub-agent. It fails silently whenever any one does not hold. A pointer that always arrives is worth more than text that usually does not.

**[Risk] An agent might not call `get_vault_overview` and so never see the conventions.**
→ Mitigation: the pointer line names the tool and the trigger ("before reading or writing notes"), the preamble's scope-discovery paragraph already routes to `get_vault_overview` first, and the tool's own description states that the response carries authoritative conventions. Three independent nudges over the two channels ADR-0010 identifies as reliable, versus one channel that was measurably delivering nothing.

**[Risk] An unmeasured client (Cursor, Windsurf) might render `instructions` in full, making this a regression there.**
→ Mitigation: none available, and accepted knowingly. This is the same unmeasured hypothetical that justified the duplication originally; the difference is that the cost is now measured and the benefit still is not. If such a client is ever confirmed, the conventions can be reinstated behind a client-aware composition — with data to size it against.

**[Risk] Verifying the change by reconnecting the MCP server reports a false negative.**
→ Mitigation: in Claude Code, `/mcp reconnect` does not rebuild the session's system prompt; changed `instructions` appear only in a fresh session. Stated in the docs as part of this change so the next person to check does not conclude the change did not land.

**[Risk] The freed ~1,300 characters invite future preamble growth.**
→ Mitigation: recorded as an explicit non-goal here and in ADR-0012, and the collapsed test asserts a constant under the cap — so growth is visible in a diff to a literal rather than hidden in a composition.

**[Trade-off] `readVaultConventions` keeps a best-effort `try/catch` that now serves one channel instead of two.**
Accepted. It is correct for the overview channel on its own terms; the guarantee simply narrows.

## Migration Plan

No deployment steps, no data migration, no configuration change. The vault-facing contract is unchanged: owners keep `.neuro-vault/for-external-agents.md` where it is, and `get_vault_overview` returns the same payload it returned before.

Ships in a normal release from `main`. Because the behaviour change is a *removal* from a best-effort channel, no client needs to act, and clients that never received the blocks (multi-vault, sub-agents, large files) observe nothing at all.

**Observability of the change.** `instructions` is composed once at server start and, in Claude Code, is only re-read by a fresh session — not by `/mcp reconnect`. Anyone verifying manually must start a new session.

**Rollback.** Revert the commit. `buildServerInstructions` is one function in one file with one call site; nothing persists state and no consumer stores the composed string.

**Acceptance** (from the tracking issue):

- `npm test && npm run lint && npm run typecheck` pass.
- No conventions file content appears in composed `instructions` for single- or multi-vault registries.
- Composed `instructions` are under 2048 characters unconditionally, with no dependence on vault configuration.
- No doc claims a per-vault `instructions` block, and no doc offers 8,000 as a budget for the `instructions` channel.

## Open Questions

None blocking. The tracking issue settles the decision, its scope, and its acceptance criteria; D1–D8 settle the forks along the way.

Two items are deliberately left to implementation rather than left open:

- **Exact wording of the pointer line.** Its required content is fixed by the spec delta (it names `get_vault_overview` and states conventions arrive there rather than in `instructions`); the sentence itself is drafted in the code review, not here.
- **Whether `CONVENTIONS_PATH`'s doc comment needs rewording** once its `instructions`-channel reference is stale. A reading call during the doc sweep, not a design decision.
