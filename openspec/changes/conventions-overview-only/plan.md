# Conventions-Overview-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop injecting per-vault conventions into the MCP `instructions` string; make `instructions` a constant that points at `get_vault_overview` instead.

**Architecture:** `buildServerInstructions(registry)` today reads every registered vault's `.neuro-vault/for-external-agents.md` and emits one block per vault ahead of a 693-character preamble. It becomes an exported string constant — preamble plus a ~240-character pointer paragraph — with no registry parameter and no file reads. The `get_vault_overview` / `vault://overview` channel that actually delivers conventions is untouched.

**Tech Stack:** TypeScript (strict, ESM, `isolatedModules`), Node ≥ 20, vitest, eslint, tsup. MCP SDK `McpServer`.

**Spec:** `openspec/changes/conventions-overview-only/` — read `proposal.md` (why), `design.md` (decisions D1–D8), and `specs/vault-conventions-delivery/spec.md` (the normative delta) alongside this plan.

## Global Constraints

- `npm test`, `npm run lint`, and `npm run typecheck` must all pass before any commit or PR (AGENTS.md).
- `npx tsc --noEmit` is authoritative for type-correctness. A `tsup` build alone is **not** — `isolatedModules`. (ADR-0002)
- Conventional Commits. Commit messages end with the repo's `Co-Authored-By` trailer, or omit the trailer.
- PRs go to `main` via `gh pr create`. Never push to `main` directly. Release is separate, on `main`, after merge.
- The client cap this change designs against is **2048 characters**, applied by Claude Code **per server, not per vault**.
- `CONVENTIONS_CHAR_CAP` stays **8,000** and keeps its current value and semantics — it is the overview channel's cap. Do not change it. (design D7)
- Do not grow `STATIC_SERVER_INSTRUCTIONS` to fill the ~1,300 freed characters. Explicit non-goal. (design "Non-Goals")
- This repo is public: never name private vault paths or note titles in code, tests, or docs.

---

### Task 1: `instructions` becomes a vault-independent constant

**Files:**
- Modify: `src/server.ts` (lines 16, 37–71, 113)
- Test: `test/server-instructions.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks — this is the foundation.
- Produces: `export const SERVER_INSTRUCTIONS: string` from `src/server.ts`. Task 2 imports this exact name. The old `buildServerInstructions(registry: IVaultRegistry): Promise<string>` export is **deleted**; no later task may reference it.

- [ ] **Step 1: Write the failing test — no vault content reaches the string**

Add to `test/server-instructions.test.ts`. This test drives the real startup wiring, not just the constant, so it catches a `server.ts` that still composes conventions somewhere:

```ts
it('puts no vault conventions content into the instructions handed to the server', async () => {
  const vault = await makeTempVault();
  try {
    const dir = path.join(vault, '.neuro-vault');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'for-external-agents.md'),
      '## Vault rules\n\n- Do not write into Resources/\n',
      'utf8',
    );

    let handed = '';
    await startNeuroVaultServer(
      {
        vaults: [
          {
            name: path.basename(vault),
            path: vault,
            smartEnvPath: path.join(vault, '.smart-env', 'multi'),
          },
        ],
        semantic: { enabled: false, modelKey: 'bge-micro-v2', modelId: 'TaylorAI/bge-micro-v2' },
      },
      {
        serverFactory: (instructions: string) => {
          handed = instructions;
          return {
            registerTool: vi.fn() as never,
            registerResource: vi.fn() as never,
            connect: vi.fn().mockResolvedValue(undefined),
          };
        },
        transportFactory: () => ({}) as never,
      },
    );

    expect(handed).not.toContain('Do not write into Resources/');
    expect(handed).not.toMatch(/Vault-specific conventions/);
    expect(handed).toBe(SERVER_INSTRUCTIONS);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
```

Add the imports it needs at the top of the file:

```ts
import { SERVER_INSTRUCTIONS, startNeuroVaultServer } from '../src/server.js';
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/server-instructions.test.ts -t 'puts no vault conventions'`
Expected: FAIL — `SERVER_INSTRUCTIONS` is not exported from `src/server.ts`.

- [ ] **Step 3: Write the failing tests for the constant's own contract**

Add these three alongside it:

```ts
it('is a constant, under the client cap, with no dependence on vault configuration', () => {
  expect(typeof SERVER_INSTRUCTIONS).toBe('string');
  expect(SERVER_INSTRUCTIONS.length).toBeLessThan(CLIENT_INSTRUCTIONS_CAP);
});

it('points at get_vault_overview for the vault-specific conventions', () => {
  expect(SERVER_INSTRUCTIONS).toContain('get_vault_overview');
  expect(SERVER_INSTRUCTIONS).toMatch(/conventions/i);
});

it('names the project-scoping probe order: overview, then search, then the user', () => {
  const probeStep = SERVER_INSTRUCTIONS.match(/Find out in this order:[^\n]*/);
  expect(probeStep).not.toBeNull();
  const step = probeStep![0];
  expect(step.indexOf('get_vault_overview')).toBeGreaterThanOrEqual(0);
  expect(step.indexOf('get_vault_overview')).toBeLessThan(step.indexOf('search_notes'));
  expect(step.indexOf('search_notes')).toBeLessThan(step.indexOf('ask the user'));
});
```

The third replaces the existing registry-driven probe-order test — that assertion is still wanted, only its input changes.

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run test/server-instructions.test.ts`
Expected: FAIL — `SERVER_INSTRUCTIONS` undefined.

- [ ] **Step 5: Replace the composition function with the constant**

In `src/server.ts`, delete the import on line 16:

```ts
import { readVaultConventions } from './lib/obsidian/vault-conventions.js';
```

**Careful:** `readVaultConventions` is still used further down, in `buildDefaultVaultEntryDeps`'s `conventionsReaderFactory` (around line 91). That usage stays — it feeds `IVaultEntry.readConventions`, which `get_vault_overview` and the `vault://overview` resource consume. Only remove the import if nothing else in the file references it; here it **is** still referenced, so **keep the import** and remove only the `buildServerInstructions` usage.

Replace the doc comment and the function (lines 37–71) with:

```ts
/**
 * The MCP `instructions` string. A constant: identical for every registry,
 * independent of how many vaults are configured, what they are named, and
 * whether any of them has a conventions file.
 *
 * It carries no vault content by design. Claude Code truncates `instructions`
 * at 2048 characters *per server, not per vault*, and gives sub-agents none of
 * it — so an owner's `for-external-agents.md` composed in here reached the
 * first vault only, and above ~1,316 characters deleted this preamble instead.
 * Conventions travel on the `get_vault_overview` response, which is uncapped,
 * read fresh per call, and reaches sub-agents; all this string carries is the
 * pointer to it. See ADR-0012 and docs/architecture/vault-conventions.md.
 *
 * The freed budget is headroom, not an allowance: anything a tool can say
 * about itself belongs in that tool's `description` (ADR-0010), so do not grow
 * this to fill 2048.
 */
export const SERVER_INSTRUCTIONS = `\
## About this vault server

This vault is the user's second brain — planning notes, decisions, reflections — and it usually outlives the project in front of you. Before brainstorming, writing a retrospective, or answering "why did we decide X", look here first; the answer often lives nowhere else.

Exact anchor (path, daily note, tag, frontmatter field) → vault operations. Fuzzy recall or a conceptual question → \`search_notes\`. Each tool's own description carries the rest — parameters, result shape, multi-vault behaviour.

You do not know how the user scopes notes to this project. Find out in this order: \`get_vault_overview\`, then \`search_notes\` on the project name, then ask the user.

This server's vaults may carry owner-authored conventions — how notes are organised, which folders are off-limits, what \`type\` values exist. They arrive on the \`get_vault_overview\` response, not here; call it before reading or writing notes.`;
```

The final paragraph is the new pointer (design D4, 241 characters). The three paragraphs above it are the existing `STATIC_SERVER_INSTRUCTIONS` verbatim — do not reword them.

- [ ] **Step 6: Update the call site**

In `startNeuroVaultServer`, replace line 113:

```ts
  const instructions = await buildServerInstructions(registry);
```

with nothing, and change the `serverFactory` call below it from `serverFactory(instructions)` to:

```ts
  const server = serverFactory(SERVER_INSTRUCTIONS);
```

- [ ] **Step 7: Run the tests and the typechecker**

Run: `npx vitest run test/server-instructions.test.ts`
Expected: the four new tests PASS. The old conventions tests still FAIL — Task 2 deletes them.

Run: `npx tsc --noEmit`
Expected: clean. If it reports an unused `IVaultRegistry` import in `src/server.ts`, check whether `startNeuroVaultServer` still needs the type; remove the import only if nothing references it.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts test/server-instructions.test.ts
git commit -m "refactor(server): make MCP instructions a vault-independent constant

Refs #93"
```

---

### Task 2: Collapse the budget and ordering suite

**Files:**
- Modify: `test/server-instructions.test.ts`

**Interfaces:**
- Consumes: `SERVER_INSTRUCTIONS` from Task 1.
- Produces: a test file with no `IVaultRegistry` fixture and no `readVaultConventions` import.

- [ ] **Step 1: Delete the tests that describe removed behaviour**

Remove these, by name, from `test/server-instructions.test.ts`:

- `keeps a representative conventions block and the whole preamble inside the client cap`
- `places the conventions block before any server-authored prose`
- `emits the preamble alone, well under the cap, when a vault has no conventions`
- `emits the vault-specific conventions section when the file exists`
- `omits the vault-specific section when the file is missing`
- `omits the vault-specific section when the file exists but is empty`
- `emits one attributed conventions block per vault in multi-vault mode`
- `emits per-vault conventions sections labelled with the vault name when only one of multiple vaults has the file`

Also delete the now-unused helpers: `makeRegistry`, `representativeConventions`, and the `makeTempVault` helper **only if** the Task 1 startup test no longer needs it (it does need it — keep `makeTempVault`).

- [ ] **Step 2: Rewrite the surviving multi-vault-prose test against the constant**

Replace `never emits a multi-vault prose section — that contract lives on each tool description` with:

```ts
it('never emits a multi-vault prose section — that contract lives on each tool description', () => {
  expect(SERVER_INSTRUCTIONS).not.toMatch(/Multi-vault mode/);
});
```

It no longer needs a registry or a temp vault: the string cannot vary.

- [ ] **Step 3: Prune the imports**

`readVaultConventions`, `IVaultRegistry`, `createExistingPathFilter`, and `createVaultScope` were only there to build the registry fixture. Remove any that are now unused. Keep `fs`, `os`, `path`, and `vi` — the Task 1 startup test uses all four.

Update the `CLIENT_INSTRUCTIONS_CAP` doc comment: it currently explains that the ordering assertions exist to keep the conventions block inside the window. Replace with a note that the cap is per server, not per vault, and that the suite now asserts the string is a constant beneath it.

- [ ] **Step 4: Run the file and confirm it is green**

Run: `npx vitest run test/server-instructions.test.ts`
Expected: PASS, with only the Task 1 tests plus the multi-vault-prose test remaining.

Run: `npx eslint test/server-instructions.test.ts`
Expected: clean — this catches leftover unused imports.

- [ ] **Step 5: Confirm the overview channel is untouched**

Run: `npx vitest run test/lib/obsidian/vault-overview.test.ts test/lib/obsidian/vault-conventions.test.ts test/operations/tools/get-vault-overview.test.ts test/operations/resources/vault-overview.test.ts`
Expected: PASS with **no edits to those files**. If any needed a change, stop and report — the change has leaked past its scope.

- [ ] **Step 6: Commit**

```bash
git add test/server-instructions.test.ts
git commit -m "test(server): assert instructions are a constant, not a fitted fixture

Refs #93"
```

---

### Task 3: ADR-0012

**Files:**
- Create: `docs/adr/0012-conventions-leave-the-instructions-channel.md`
- Modify: `docs/adr/INDEX.md`

**Interfaces:**
- Consumes: nothing. Parallel-safe with Tasks 4 and 5.
- Produces: ADR-0012, referenced by the `src/server.ts` doc comment from Task 1 and by the docs in Task 4. **This task alone owns `docs/adr/INDEX.md`** — no other task may edit it.

- [ ] **Step 1: Draft the ADR from the template**

Copy the structure of `docs/adr/0000-template.md` and follow the prose style of `docs/adr/0010-context-delivery-channels.md`. Status **Accepted**, date **2026-08-24**.

**Context** must carry the measurement table verbatim from `design.md` §Context, and these four findings:
1. The cap is per server, not per vault — the first registered vault consumes the budget, later blocks arrive as nothing. Reproduced in both registration orders on 15.3.0.
2. Conventions-first ordering meant the preamble died first — anything over ~1,316 characters deleted it entirely, contradicting the `src/server.ts` comment claiming it was "sized to fit in what is left".
3. The CI guard was asymmetric — `test/server-instructions.test.ts` pinned a 1,227-character conventions fixture and varied only the preamble, so the free variable in production was the constant in CI.
4. No truncation signal — the overview channel flags trimming with `conventions_truncated`; `instructions` has no response shape to carry one, so every failure above was silent.

**Decision**: cut the channel rather than patch it. `buildServerInstructions` becomes a constant; `instructions` carries a pointer to `get_vault_overview` instead of the text.

- [ ] **Step 2: State the relationship to ADR-0010 explicitly**

This is the sentence a future reader most needs, so do not leave it implied:

> This applies ADR-0010 rather than reversing it. ADR-0010 says `instructions` carries only what no tool description can carry. Conventions entered under "no description can supply another vault's rules" — true of the *text*, false of the *pointer*, and `get_vault_overview`'s description already carries that pointer today. The duplication was accepted for a hypothetical client that renders `instructions` uncapped; the same ADR records that Cursor and Windsurf were never measured. We were paying a measured cost for an unmeasured benefit.

Do **not** edit ADR-0010 — ADRs are immutable (ADR-0008).

- [ ] **Step 3: Record the consequences, including the cost and the non-goal**

Cover, in **Consequences**:
- What the cut removes in one move: the dead preamble, the multi-vault first-come-takes-all, the misleading README sentence, the need for a startup budget warning, and the need for budget-aware multi-vault composition.
- The accepted cost: an owner relying on conventions reaching the system prompt *without* a tool call loses that. Note it was already conditional on four things at once — a client that renders `instructions`, a single vault, a file under ~1,316 characters, and a main agent rather than a sub-agent.
- The non-goal: the freed ~1,300 characters are headroom, not an allowance for preamble growth.
- The verification footnote: in Claude Code, `/mcp reconnect` does not rebuild the session's system prompt, so a changed `instructions` string is only observable in a fresh session.

Under **Alternatives considered**, record the three from design D1: emit only the first vault's conventions budget-checked; reverse the order so the preamble leads; warn on stderr at startup.

- [ ] **Step 4: Add the INDEX row**

Open `docs/adr/INDEX.md`, read the existing row format, and add the ADR-0012 row matching it exactly.

- [ ] **Step 5: Commit**

```bash
git add docs/adr/0012-conventions-leave-the-instructions-channel.md docs/adr/INDEX.md
git commit -m "docs(adr): record why conventions leave the instructions channel (ADR-0012)

Refs #93"
```

---

### Task 4: Documentation sweep

**Files:**
- Modify: `README.md` (around lines 180–189)
- Modify: `docs/architecture/vault-conventions.md` (lines 17, 19, 37–52, 76–90)
- Modify: `docs/architecture/mcp-server-shape.md` (lines 27, 29)
- Modify: `docs/architecture/vault-registry.md` (line 64)
- Modify: `docs/architecture/obsidian-lib.md` (lines 22, 49)
- Modify: `docs/guide/configuration.md` (lines 30, 36)
- Modify: `src/lib/obsidian/vault-conventions.ts` (the `CONVENTIONS_CHAR_CAP` doc comment, lines 7–13)

**Interfaces:**
- Consumes: ADR-0012's filename from Task 3, for cross-references.
- Produces: nothing other tasks import. Parallel-safe with Tasks 3 and 5; internally parallel — six disjoint files, one per subagent. **No subagent here may touch `docs/adr/INDEX.md`** (Task 3 owns it).

- [ ] **Step 1: `README.md` — delete the claim, do not rewrite it**

Delete the whole `📨 **At the front of the MCP `instructions`**…` bullet, and delete this sentence outright:

> With several vaults registered, each one carries its own file: every entry in a fanned-out `results_by_vault` gets its own vault's `conventions`, and the `instructions` get one clearly-labelled block per vault.

Replace it with a multi-vault sentence that describes only the overview channel — e.g. that every entry in a fanned-out `results_by_vault` carries its own vault's `conventions`. Rewrite the "It is delivered two ways:" lead-in accordingly. Keep the 8,000-character paragraph unchanged: it correctly describes the overview channel (design D7). Emojis in the README are deliberate house style — keep them.

- [ ] **Step 2: `docs/architecture/vault-conventions.md` — remove the two-channel framing**

- Line 17: drop "the one to rely on" framing, which only means something against a second channel.
- Line 19: delete the `**The `instructions` channel — best-effort.**` paragraph entirely.
- Lines 37–46: delete the `### The `instructions` channel` section, including the description of the 1,227-character fixture guard and the "measured total is 1,953 characters" arithmetic — all of it describes deleted behaviour.
- Line 52: restate the cap as the overview channel's own, dropping the parenthetical contrast with the `instructions` channel's client budget.
- Lines 76–78: the notes claiming the ordering rule protects the `instructions` budget describe a rule that no longer exists — replace with a pointer to ADR-0012.
- Line 90: update the `test/server-instructions.test.ts` line — it now guards a constant under the cap, not ordering.

- [ ] **Step 3: `docs/architecture/mcp-server-shape.md`**

Line 27 says `buildServerInstructions(registry)` composes the string at startup — it no longer takes a registry and composes nothing. Describe the constant, keep the ADR-0010 reference, and add ADR-0012. Line 29 delegates "the per-vault conventions blocks that lead it" to `vault-conventions.md`; rewrite it to hand off only the overview-channel delivery.

- [ ] **Step 4: `docs/architecture/vault-registry.md`**

Line 64 in the dataflow diagram reads:

```
      └─── buildServerInstructions(registry)     ──► MCP instructions (per-vault conventions blocks)
```

The registry no longer feeds instructions at all — remove this edge from the diagram rather than relabelling it. **Keep** the `readConventions` per-vault-capability paragraph at line 29: it stays load-bearing for `get_vault_overview` and the `vault://overview` resource.

- [ ] **Step 5: `docs/architecture/obsidian-lib.md`**

Line 22 says `vault-conventions.ts` is "Shared by the `get_vault_overview` payload and by `buildServerInstructions`" — drop the second consumer. Line 49 lists the per-vault conventions reader among the registry-wiring factories; that wiring is unchanged, so only fix it if it credits `buildServerInstructions` as a consumer.

- [ ] **Step 6: `docs/guide/configuration.md`**

Line 36: delete "The same text is also placed at the front of the MCP `instructions`, best-effort, for clients that render them — but that copy is composed once at server startup, so only the `get_vault_overview` channel reflects later edits." The freshness point survives on its own without the contrast.

Line 30's routing advice is still correct — it already tells owners not to point at the server's `instructions`. Leave it, and append the verification footnote near it:

> Verifying a change to the server's `instructions` needs a **fresh session**: in Claude Code, `/mcp reconnect` reconnects the server but does not rebuild the session's system prompt, so the old string stays in place and the change reads as a false negative.

- [ ] **Step 7: `src/lib/obsidian/vault-conventions.ts` — reading call on the cap comment**

The `CONVENTIONS_CHAR_CAP` comment says "Unlike the MCP `instructions` channel there is no client-imposed limit here". The contrast is now stale, since that channel carries no conventions. Reword to state the cap's own purpose — one oversized file should not inflate every overview response, and trimming is always flagged, never silent. **Leave the constant at 8,000 and leave `capConventions` and `readVaultConventions` alone.**

- [ ] **Step 8: Commit**

```bash
git add README.md docs/ src/lib/obsidian/vault-conventions.ts
git commit -m "docs: drop the instructions channel from the conventions story

Refs #93"
```

---

### Task 5: Repo-wide sweep, gates, and delivery

**Files:**
- Modify: any file the sweep turns up that Tasks 1–4 missed.

**Interfaces:**
- Consumes: everything above. This task is **last and sequential** — nothing else may be in flight.
- Produces: the PR.

- [ ] **Step 1: Sweep for surviving claims**

A sweep scoped to `docs/architecture/` alone misses the guide layer — cover the whole repo:

```bash
grep -rn "instructions" --include="*.md" --include="*.ts" . --exclude-dir=node_modules --exclude-dir=.git | grep -i "convention"
```

```bash
grep -rn "8,000\|8000" --include="*.md" --include="*.ts" . --exclude-dir=node_modules --exclude-dir=.git
```

Every hit on the second must be about the overview channel's `CONVENTIONS_CHAR_CAP`. Any hit offering 8,000 as an `instructions` budget is a defect this change must fix.

- [ ] **Step 2: Confirm the old symbol is gone**

```bash
grep -rn "buildServerInstructions" . --exclude-dir=node_modules --exclude-dir=.git
```

Expected: hits only in `openspec/changes/conventions-overview-only/` (the artifacts, which describe the change) and in ADR-0012's historical account. No hit in `src/`, `test/`, or `docs/architecture/` describing it as current behaviour.

- [ ] **Step 3: Validate the OpenSpec artifacts**

Run: `npx openspec validate --all`
Expected: all items pass. Confirm the delta's four MODIFIED headers and one REMOVED header still match `openspec/specs/vault-conventions-delivery/spec.md` verbatim — archive applies MODIFIED by full-text replacement, so a drifted header fails at archive time rather than here.

- [ ] **Step 4: Run the gates, verbatim**

Run each, and read the output rather than inferring the result:

```bash
npm test
```

```bash
npm run lint
```

```bash
npm run typecheck
```

```bash
npm run build
```

All four must pass — CI enforces the same set. Run `npm run lint` exactly as written; a path-scoped `eslint src/` misses repo-root files.

- [ ] **Step 5: Verify the four acceptance criteria against real output**

From the tracking issue — check each against command output, not inference:

1. `npm test && npm run lint && npm run typecheck` pass.
2. No conventions file content appears in composed `instructions` for single- or multi-vault registries — covered by the Task 1 startup test; confirm it ran.
3. Composed `instructions` are under 2048 characters unconditionally, with no dependence on vault configuration — confirm the constant's length test ran, and print the length:
   ```bash
   node -e "import('./dist/server.js').then(m => console.log(m.SERVER_INSTRUCTIONS.length))"
   ```
4. No doc claims a per-vault `instructions` block, and no doc offers 8,000 as a budget for the `instructions` channel — the Step 1 greps.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin HEAD
```

```bash
gh pr create --base main --title "feat(instructions): keep vault conventions on get_vault_overview only" --body "Closes #93"
```

This is the change's only PR, so it carries `Closes #93`. Never push to `main` directly; the release runs separately, on `main`, after merge.

---

## Self-Review

**Spec coverage** — every requirement in `specs/vault-conventions-delivery/spec.md` maps to a task:

| Requirement | Task |
| --- | --- |
| ADDED: Instructions point at the overview channel for conventions | 1 (steps 3, 5) |
| MODIFIED: Composed instructions do not restate tool descriptions | 1 (steps 1, 3, 5), 2 (step 2) |
| MODIFIED: Conventions are read at call time | 2 (step 5) — asserted unchanged; the removed startup copy is what the modification records |
| MODIFIED: Each vault's conventions travel with that vault | 2 (step 5) — overview fan-out untouched; the dropped clause is verified absent by Task 1's startup test |
| MODIFIED: An unreadable conventions file never fails a call | 1 (step 1) — startup composes instructions without consulting the file at all |
| REMOVED: A vault's conventions survive the instructions truncation budget | 2 (step 1) |

**Type consistency** — `SERVER_INSTRUCTIONS` is the single name used in Tasks 1, 2, and 5. `buildServerInstructions` appears only as the symbol being deleted, and Task 5 step 2 verifies it is gone.

**Known gap, deliberate** — the spec scenario "the string does not vary with the registry" is asserted structurally (a `const` cannot vary) plus behaviourally via Task 1's startup test, rather than by composing two registries and diffing. Composing two registries is no longer possible once the function takes no registry; that impossibility *is* the guarantee.
