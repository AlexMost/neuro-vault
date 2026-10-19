# ADR index

Architecture Decision Records — the **why** behind non-reversible choices in this repo. New decisions get a new file; supersession is recorded by updating the **Status** of the old file and adding the new one.

This is the durable rationale layer. For how a concept works now see [`docs/architecture/`](../architecture/README.md); for what a capability must do see [`openspec/specs/`](../../openspec/specs/); the full map is in [`docs/workflow.md`](../workflow.md).

Template: [0000-template.md](0000-template.md).

| #    | Title                                                                                                 | Status   |
| ---- | ----------------------------------------------------------------------------------------------------- | -------- |
| 0001 | [Spec workflow: OpenSpec + superpowers-bridge](0001-spec-workflow-openspec-superpowers.md)            | Accepted; doc-altitude map superseded in part by [0011](0011-retire-frozen-doc-layer.md) |
| 0002 | [ESM + TypeScript strict; `tsc --noEmit` is the build source of truth](0002-esm-typescript-strict.md) | Accepted |
| 0003 | [Structured tool errors via `ToolHandlerError`](0003-structured-errors-toolhandlererror.md)           | Accepted; input-validation instruction refined in part by [0015](0015-input-gate-owns-schema-validation.md) |
| 0004 | [External processes via `execFile`, never a shell string](0004-execfile-no-shell.md)                  | Accepted |
| 0005 | [MCP parameter dictionary: one concept = one name](0005-mcp-parameter-dictionary.md)                  | Accepted |
| 0006 | [Smart Connections as the read-only embedding corpus](0006-smart-connections-corpus.md)               | Superseded by [0013](0013-own-embedding-corpus.md), [0014](0014-background-corpus-freshness.md) |
| 0007 | [obsidian-cli as the vault write path; reads from disk](0007-obsidian-cli-write-path.md)              | Superseded by [0009](0009-disk-direct-vault-operations.md) |
| 0008 | [`docs/architecture/` as living per-concept documentation](0008-architecture-living-docs.md)          | Accepted |
| 0009 | [Vault operations go direct to disk](0009-disk-direct-vault-operations.md)                            | Accepted; `VaultProvider` method set refined in part by [0016](0016-one-disk-module-owns-note-writes.md) |
| 0010 | [Context reaches agents through tool descriptions and responses](0010-context-delivery-channels.md)   | Accepted |
| 0011 | [Four doc altitudes; the frozen pre-OpenSpec record is retired](0011-retire-frozen-doc-layer.md)       | Accepted |
| 0012 | [Vault conventions leave the `instructions` channel](0012-conventions-leave-the-instructions-channel.md) | Accepted |
| 0013 | [The server builds and owns its embedding corpus](0013-own-embedding-corpus.md)                        | Accepted; model identity and text bound refined in part by [0017](0017-embedding-model-profiles.md) |
| 0014 | [Background corpus freshness, and the removal it enabled](0014-background-corpus-freshness.md)         | Accepted; in-process per-session watcher superseded in part by [0020](0020-per-vault-state-in-the-daemon.md) |
| 0015 | [The registration gate owns schema validation; `INVALID_ARGUMENT` is for semantic faults](0015-input-gate-owns-schema-validation.md) | Accepted |
| 0016 | [One disk module owns note writes; `VaultProvider` survives only as a test seam](0016-one-disk-module-owns-note-writes.md) | Accepted |
| 0017 | [Embedding models are a closed set of verified profiles](0017-embedding-model-profiles.md) | Accepted; per-profile directories adopted 2026-10-14 |
| 0018 | [A shared-services daemon per installed build; the embedding provider is its first client](0018-shared-services-daemon.md) | Accepted |
| 0019 | [The corpus is an interface inside the daemon; sessions read it, never its vectors](0019-embedding-storage-interface.md) | Accepted |
| 0020 | [Per-vault state lives in the daemon's vault entry](0020-per-vault-state-in-the-daemon.md) | Accepted; "the fallback runs the same module" refined in part by [0021](0021-vault-client.md) |
| 0021 | [One vault client per vault root; per-vault reads are views over it](0021-vault-client.md) | Accepted |
