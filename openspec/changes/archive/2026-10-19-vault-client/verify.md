# Verification Report

> Produced by `/opsx:verify` after the apply phase, to confirm the implementation matches specs, design and
> tasks. Test paths are relative to `test/`; source paths are relative to the repository root.

**Change**: `vault-client`
**Verified at**: `2026-10-19 23:25`
**Verifier**: Claude Opus 5.5 (the PR 2 session). It ran the gates, the eval and the scenario mapping itself. A
read-only reviewer agent read the PR 2 diff before the PR (section 4.3).

Scope: the whole change, which shipped as two PRs. PR 1 (#200, squash `70b7ee6`, tasks 1–6) is merged to `main`.
This report covers PR 2 (tasks 7–9), on branch `claude/cranky-raman-d3c80e` from `bd5823c`: `9004465` (7.1),
`51376fb` (7.2), `40aaffa` (8.1), `2875b3d` (9.1), and the commit that adds this report, the retrospective and the
archive.

## Summary

| Dimension    | Result |
| ------------ | ------ |
| Completeness | 18 of 18 tasks done (9.2 closes with this report, the retrospective, the archive and the PR). 5 requirements, 9 scenarios in 1 delta spec, all implemented. |
| Correctness  | 9 scenarios: 9 covered by tests. Every scenario of the 3 deleted test files has a counterpart (section 4.2). |
| Coherence    | D1–D11 followed. D9/8.1 carries one intended behaviour change (section 4.1). 0 unrecorded deviations. |

---

## 0. Gates

At `2875b3d`:

| gate | result |
| --- | --- |
| `npm test` | pass: **2584 passed / 4 skipped**. `main` at `bd5823c` is 2586 / 4. Net −2: 17 tests deleted with their files (daemon-reader 12, local-reader 4, `createLocalAttachment` 1), 15 added (lexical view 8, in-process lexical 4, client 1, factory end-to-end 1, embedding provider 1). |
| `npm run lint` (`eslint .`) | clean |
| `npm run typecheck` | clean |
| `npm run format` | clean |
| `npm run build` | success |
| `npx commitlint --from origin/main --to HEAD` | clean |

### Eval (`npm run eval`)

Owner's vault at `vault_sha 7c78b75`, `harrier-270m`, golden set n=25. Before is `main` (`bd5823c`) in a
throwaway worktree, after is `2875b3d`; both pipelines.

| pipeline | p@3 | MRR | hit@3 | before = after |
| --- | --- | --- | --- | --- |
| fused | 0.440 | 0.792 | 0.920 | yes |
| semantic | 0.373 | 0.709 | 0.800 | yes |

The reports' `config`, `golden`, `metrics` and `per_query` are equal as JSON; only `code_sha` and `vault_sha` differ
(the vault's working tree had uncommitted edits during the `main` runs and none during the branch runs, so the
`-dirty` suffix differs; the scores do not). Expected: the eval's runtime path (`runRetrievalPipeline`, `ShardCorpus`,
`createStandaloneLexicalReader`) contains no file this PR changed.

---

## 1. Structural Validation (`openspec validate --all --json`)

- [x] All items `"valid": true`

**Result**: 25 items, 0 invalid.

---

## 2. Task Completion (`tasks.md`)

- [x] Every `- [ ]` is `- [x]`

No open task. 9.2 is ticked with this commit.

---

## 3. Delta Spec Sync State

| Capability | Sync state | Note |
| --- | --- | --- |
| `vault-client` | ✗ needs sync | ADDED, 5 requirements, 9 scenarios; `openspec/specs/vault-client/` does not exist yet. `openspec archive` creates it. |

---

## 4. Design / Specs Coherence

| Sample | design | specs | Gap |
| --- | --- | --- | --- |
| One client per root and side, views only | D5–D8 | Req. 1 | none: `createVaultClients` (`src/modules/semantic/vault-client/index.ts`) builds one client per root and side; `createSemanticBackendView` and `createLexicalReaderView` hold only the client. |
| The method table | D1 | Req. 2 | none: the lexical view calls `client.call('lexical.search', …)` with no `vault` key. |
| One error vocabulary | D2, D3 | Req. 3 | none: the in-process lexical path now goes through the `lexical` handler; `NOT_ATTACHED` is handled in the client only. |
| No connection id in the session | D3, D8 | Req. 4 | none: `LOCAL_CONNECTION_ID` and `createInProcessLink`'s `clientId` option are gone; `grep -rn "connectionId\|LOCAL_CONNECTION_ID" src` is empty. |
| The cost claim | D10 | Req. 5 | none: `vault-client/new-read.test.ts` unchanged and passing. |

**Drift warnings** (non-blocking): none.

### 4.1 Requirement → evidence

| Requirement / scenario | Evidence |
| --- | --- |
| One attach per vault per connection epoch | `integration/session-daemon.test.ts` "a restarted server sees one attach before both legs" (now with the lexical view); `vault-client/factory.test.ts` "the semantic backend and the lexical reader of a vault share one attach" |
| The switch moves every reader of a vault at once | `vault-client/factory.test.ts` "--shared: once the switch went local, the reader attaches the in-process entry", "--shared builds the entries once…"; `vault-client/client.test.ts` "every call goes to the local client once the switch is local" (now incl. `lexical.search`) |
| Status while attaching | `vault-client/client.test.ts` "status answers indexing 0/0 at once while ensure is pending", "status reads indexing 0/0 while the attach is in flight" |
| A view cannot send a vault key | typecheck over `src/modules/semantic/lexical/view.ts`; `vault-client/client.test.ts` "calls carry the vault key and the per-method timeout" (now incl. `lexical.search`, 30 s) |
| A corpus that is not ready refuses the same way on both sides | `vault-client/in-process.test.ts` "a read while indexing is refused CORPUS_NOT_READY…", "the same read answers the same…"; `backend/view.test.ts` |
| A detached vault re-attaches on the next call | `vault-client/client.test.ts` "NOT_ATTACHED on a call forgets the attach"; `vault-client/in-process.test.ts` "an entry that lost the attach answers NOT_ATTACHED once; the next search attaches again" |
| Disposing the fallback detaches it | `vault-client/factory.test.ts` "dispose closes the in-process link before disposing the entries" (detach with the loopback's own id) |
| A hypothetical read through both adapters | `vault-client/new-read.test.ts` |
| 8.1: a handshake on a replaced epoch commits nothing | `semantic/daemon-embedding-provider.test.ts` "a handshake answered on a replaced connection commits nothing"; the other 14 tests of that file unchanged (the diff to it is additions only) |

**One intended behaviour change (D4, D9, task 8.1).** Before, `DaemonEmbeddingProvider` shared one handshake
promise across epochs and took the batch size from whatever answered, even after a reconnect. Now the batch size
is committed only on the epoch the handshake ran on, and a caller on a new epoch starts its own handshake instead
of joining the old one. A caller whose own handshake lands on a replaced epoch proceeds, as before.

### 4.2 Deleted tests → counterparts

| Deleted scenario | Counterpart |
| --- | --- |
| daemon-reader: sends snake_case params and maps the result | `lexical/view.test.ts` same name; `vault-client/client.test.ts` "calls carry the vault key and the per-method timeout" (key, 30 s) |
| daemon-reader: allowed is sent only when given | `lexical/view.test.ts` same name |
| daemon-reader: LEXICAL_FAILED is a LexicalSearchError | `lexical/view.test.ts` "LEXICAL_FAILED is a LexicalSearchError with the entry's message" |
| daemon-reader: a vault the daemon cannot attach | `lexical/view.test.ts` "a vault that cannot be attached, and any other refusal…"; `vault-client/client.test.ts` "VAULT_UNAVAILABLE reads unavailable and re-attaches next call" |
| daemon-reader: a timeout fails the call, mode stays daemon | `lexical/view.test.ts` "a timeout reads \"daemon did not answer\""; `vault-client/client.test.ts` "a call that times out or loses the connection rejects as itself, and never flips the switch" |
| daemon-reader: a dropped connection and closed services | `lexical/view.test.ts` same name; client test above |
| daemon-reader: any other daemon error | `lexical/view.test.ts` "…and any other refusal, is a LexicalSearchError" |
| daemon-reader: an answer without a notes array | `lexical/view.test.ts` same name |
| daemon-reader: NOT_ATTACHED forgets the attach | `vault-client/client.test.ts` "NOT_ATTACHED on a call forgets the attach" |
| daemon-reader: delegates to local once the switch is local | `vault-client/client.test.ts` "every call goes to the local client once the switch is local; it is built once" |
| daemon-reader: warm attaches and never rejects | `vault-client/client.test.ts` "warm attaches and never rejects"; `lexical/view.test.ts` "warm is the client warm-up" |
| daemon-reader: warm hands the attach to the in-process side | `vault-client/client.test.ts` "every call goes to the local client…" (asserts `local.warm`) |
| local-reader: search equals the entry's lexicalSearch | `vault-client/in-process.test.ts` "answers the entry's own lexicalSearch"; `lexical/parity.test.ts`; `vault-client/factory.test.ts` end-to-end `--no-shared` |
| local-reader: warm attaches and never rejects | `vault-client/in-process.test.ts` "warm attaches, and never rejects for a vault that cannot be attached" |
| local-reader: a vault that cannot be attached | `vault-client/in-process.test.ts` "a vault that cannot be attached is a LexicalSearchError" |
| local-reader: NOT_ATTACHED forgets, next search attaches | `vault-client/in-process.test.ts` "an entry that lost the attach answers NOT_ATTACHED once…" |
| backend/attachment.test.ts `createDaemonAttachment` (10) | moved to `vault-client/attachment.test.ts` over `createAttachment` and a fake link, same 10 scenarios |
| backend/attachment.test.ts `createLocalAttachment`: once, under the fixed id; forget re-attaches | `vault-client/in-process.test.ts` "status reads indexing 0/0…" (one attach), `vault-client/factory.test.ts` "--no-shared serves every vault…" (one loopback id), `vault-client/attachment.test.ts` "forget makes the next key attach again" |

### 4.3 Review

A read-only reviewer agent read `git diff origin/main..HEAD` against the deleted code, ran the lexical,
vault-client, embedding-provider and session-daemon suites (128 tests, all passing), and checked the touched
docs against the code. It found nothing critical or important:

- Lexical path, daemon side: params, timeout, messages, error classes, the `NOT_ATTACHED` forget, the switch,
  `warm()` and the refusal after dispose match the deleted reader.
- Lexical path, in-process side: the messages are the same, since the entry never throws a `LexicalSearchError`
  itself. `toWire`/`fromWire` loses no field. The handler's param checks cannot fail for what the pipeline
  sends. The one difference is the `cause` class: a `DaemonRpcError` where it was a `VaultEntryError`. It
  reaches only stderr, and design.md's Trade-offs already accept it.
- Embedding handshake: a caller on a new epoch runs its own handshake instead of joining the old one. A caller
  whose handshake lands on a replaced epoch proceeds without one, as before (noted in §4.1).
- No runtime import cycle: the `view.ts` ↔ `vault-client/index.ts` edges `madge` reports are `import type`.
- Every deleted scenario has a counterpart, matching §4.2.

---

## 5. Implementation Signal

- [x] No unstaged files in the worktree
- [x] Commits pushed with the PR

**Commit range**: `bd5823c..HEAD`

---

## 6. Front-Door Routing Leak Detector

- [x] `docs/superpowers/specs/*.md`: no files.

---

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

`plan.md` has no `[~]` row. Nothing deferred.

---

## Overall Decision

- [x] ✅ PASS — ready for the retrospective, archive and PR

**Next**: `retrospective.md`, `openspec archive vault-client`, then the PR that closes #193.
