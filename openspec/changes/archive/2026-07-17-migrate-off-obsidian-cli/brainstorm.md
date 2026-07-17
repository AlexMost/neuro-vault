<!--
Raw capture of superpowers:brainstorming output.

本檔原樣捕捉 brainstorming skill 的產出，不強制結構。
Skill 的自然產出通常是 decision log 格式（背景 → 決議鏈 Q1-Qn → 設計取捨），
但依對話內容可能有不同組織方式。

design.md 從本檔萃取並重新整理為結構化設計文件。

不要將本檔的內容複製到 design.md — design.md 是獨立的重組產物，
兩者互補但不重疊。
-->

# Brainstorm — migrate-off-obsidian-cli

> Verbal brainstorming ran in-chat during an `/opsx:explore` session on
> 2026-07-16 (per `.claude/rules/opsx-routing.md` entry routing). This file is
> the raw decision-log capture of that session. Vault-side planning notes:
> `Tasks/neuro-vault/FsVaultProvider.md` + three blocked leg notes.

## Background

Bro v0 deployment planning surfaced the blocker: the Hermes config relies on
`create_note` (URL → task capture) and `read_daily` (session priming), and both
route through `ObsidianCLIProvider`, which requires the `obsidian` CLI binary
AND a running Obsidian instance. On a headless VPS every provider-backed tool
is dead: `create_note`, `read_daily`, `set_property`, `remove_property`,
`list_tags`, `list_properties`, and partially `get_vault_overview` (it calls
`provider.listTags()` + `provider.listProperties()`).

Already disk-direct (no Obsidian needed): `read_notes`, `query_notes`,
`edit_note` (via `FsVaultWriter`), `get_note_links`, the lexical leg of
`search_notes`.

Code anchors confirmed during the session:

- `VaultProvider` interface: `src/lib/obsidian/vault-provider.ts` (6 methods).
- Hardcoded provider construction: `src/server.ts` `buildDefaultVaultEntryDeps`
  → `new ObsidianCLIProvider(...)` (~line 180).
- `providerFactory` seam: `src/lib/vault-registry.ts` `IVaultEntryDeps`;
  reader/writer are built *before* the provider in `VaultRegistry.create`.
- Uncaught provider fan-in: `src/lib/obsidian/vault-overview.ts:47` —
  `Promise.all([provider.listTags(), provider.listProperties()])`, no catch.
- `daily-notes-config.ts` already exists in `src/lib/obsidian/` (asset for the
  readDaily leg).

## Decision chain

### Q1 — Config flag `--vault-provider fs|cli`?

Initial vault-note plan: explicit flag, no auto-fallback (laptop keeps CLI for
templates/`types.json`, VPS uses fs). **Rejected during the session.** No
config surface at all: one provider path, migrated gradually. Rationale: the
flag, its yargs conflicts with `--obsidian-cli`, conditional server
instructions, and the "what does a mid-migration release ship" question all
evaporate.

### Q2 — `NOT_IMPLEMENTED` stubs in the skeleton?

Initial plan: skeleton methods throw `NOT_IMPLEMENTED`. **Rejected.** A stub
window breaks `get_vault_overview` outright (the uncaught `Promise.all` above)
— and that is the orientation tool server instructions tell every agent to
call first. It would also add a transient error code to the tool-error
dictionary for no lasting benefit.

### Q3 — Delegation shape: injected delegate vs internal construction?

Considered `FsVaultProvider({ delegate, reader, writer })` wired in
`server.ts`. **Decided: internal construction.** `FsVaultProvider` accepts the
same options bag as `ObsidianCLIProvider` (`ObsidianCLIProviderOptions`,
including the `exec`/`stat` test seams) and constructs the CLI provider inside
its own constructor. Not-yet-migrated methods call through to it. Wiring in
`server.ts` changes by exactly one class name; `providerFactory` signature is
untouched. Strangler fig: each migration PR flips one method from delegation
to a disk implementation; when no delegations remain, the CLI provider is
deleted entirely.

### Q4 — Thread `reader`/`writer` into `providerFactory` in the skeleton?

Considered pre-threading to avoid churn. **Decided: no.** The skeleton carries
no dead fields; the first leg that needs reader/writer adds them to the
factory opts (a few lines in `vault-registry.ts` + `server.ts`, done once).

### Q5 — Process routing: direct PR vs opsx?

Initially routed as a direct PR ("skeleton touches no contracts"). **Corrected
by user, agreed: opsx.** The unit being routed is the architectural decision —
migrating off Obsidian CLI — not the individual PR. It is ADR-level (new
headless capability; tool *semantics* shift even where schemas don't; the
`CLI_*` error-code dictionary dies at the end). One opsx change covers the
whole migration; the skeleton is task 1.

## Design trade-offs accepted

- **Zero-regression migration**: on the laptop behavior is identical until a
  method migrates; on the VPS unmigrated methods keep failing with
  `CLI_NOT_FOUND` exactly as today, migrated ones come alive. Monotonic
  improvement, no stub window, `get_vault_overview` works throughout.
- **End state kills CLI on the laptop too.** Known behavioral differences,
  each owned by its leg:
  - `createNote` templates — non-loss: content arrives fully formed from the
    caller (CLI delegated templating to Obsidian; Bro never needed it).
  - `setProperty` — fs YAML writes do not register new property types in
    Obsidian's `types.json` UI registry (write-leg question).
  - `listTags` via scan counts frontmatter tags only; the CLI also counts
    inline `#tags` in note bodies — counts will diverge (scan-leg question).
- **Leg ordering freedom**: scan leg first revives `get_vault_overview` in
  headless mode cheapest; Bro v0 specifically needs `createNote` + `readDaily`.
  Order is a plan-level choice, not a design constraint.
- **The only contract-touching step is the last one**: deleting
  `obsidian-cli-provider.ts` removes `CLI_NOT_FOUND`/`CLI_UNAVAILABLE`/
  `CLI_TIMEOUT` from the error dictionary and the "CLI availability" section
  from server instructions. Covered by this change's specs rather than a
  separate decision.
