# ADR index

Architecture Decision Records — the **why** behind non-reversible choices in this repo. New decisions get a new file; supersession is recorded by updating the **Status** of the old file and adding the new one.

This is the durable rationale layer. For how a concept works now see [`docs/architecture/`](../architecture/README.md); for what a capability must do see [`openspec/specs/`](../../openspec/specs/); the full map is in [`docs/workflow.md`](../workflow.md).

Template: [0000-template.md](0000-template.md).

| #    | Title                                                                                                 | Status   |
| ---- | ----------------------------------------------------------------------------------------------------- | -------- |
| 0001 | [Spec workflow: OpenSpec + superpowers-bridge](0001-spec-workflow-openspec-superpowers.md)            | Accepted |
| 0002 | [ESM + TypeScript strict; `tsc --noEmit` is the build source of truth](0002-esm-typescript-strict.md) | Accepted |
| 0003 | [Structured tool errors via `ToolHandlerError`](0003-structured-errors-toolhandlererror.md)           | Accepted |
| 0004 | [External processes via `execFile`, never a shell string](0004-execfile-no-shell.md)                  | Accepted |
| 0005 | [MCP parameter dictionary: one concept = one name](0005-mcp-parameter-dictionary.md)                  | Accepted |
| 0006 | [Smart Connections as the read-only embedding corpus](0006-smart-connections-corpus.md)               | Accepted |
| 0007 | [obsidian-cli as the vault write path; reads from disk](0007-obsidian-cli-write-path.md)              | Superseded by [0009](0009-disk-direct-vault-operations.md) |
| 0008 | [`docs/architecture/` as living per-concept documentation](0008-architecture-living-docs.md)          | Accepted |
| 0009 | [Vault operations go direct to disk](0009-disk-direct-vault-operations.md)                            | Accepted |
