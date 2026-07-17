# ADR-0009 — Vault operations go direct to disk (supersedes ADR-0007)

- **Status**: Accepted
- **Date**: 2026-07-17

## Context

ADR-0007 routed vault **writes** through the `obsidian` CLI (`ObsidianCLIProvider`) so that Obsidian's own link index, Daily Notes plugin, and file conventions stayed authoritative, while batch **reads** already went straight to disk via `FsVaultReader`. That split assumed an Obsidian desktop installation was always reachable from the machine running the MCP server.

The target deployment for the next phase (a headless VPS running the "Bro" always-on agent, v0) has no desktop environment and no Obsidian app — there is nothing for a CLI to shell out to, and nothing to keep in sync with. The change `migrate-off-obsidian-cli` strangler-figged every `VaultProvider` write method over to direct filesystem operations one at a time (create, daily, properties, tags), verified at each step against the existing test suite, and this ADR records the completed state.

## Decision

All `VaultProvider` methods — `createNote`, `readDaily`, `setProperty`, `removeProperty`, `listTags`, `listProperties` — operate directly on the vault directory via `FsVaultProvider` (`src/modules/operations/fs-vault-provider.ts`), using `node:fs/promises` and the same `VaultReader` the read paths already used. No external process is spawned for any vault operation.

ADR-0004 (external processes via `execFile`, never a shell string) is **not repealed** — it still governs the shape of any *future* external-process invocation this server adds — it is simply no longer exercised by vault operations, since there is no longer an external process in that path at all.

## Consequences

- No Obsidian runtime dependency anywhere in the server: it starts, reads, and writes with only a vault directory on disk. This is what makes headless (VPS, container, CI) deployment possible.
- The `--obsidian-cli` flag and the `CLI_NOT_FOUND` / `CLI_UNAVAILABLE` / `CLI_TIMEOUT` error codes are removed entirely (major version bump — this is a breaking change for any client branching on those codes).
- `ObsidianCLIProvider` and its stderr-pattern error mapping are deleted; there is no longer a "CLI returned success but the disk effect was wrong" failure mode to guard against for `create_note` (see [`docs/architecture/disk-write-path.md`](../architecture/disk-write-path.md), the renamed/rewritten successor to `cli-write-defenses.md`).
- Accepted divergences from the old CLI-backed behavior, each traded for headless operation:
  - **(a) `listTags` counts frontmatter tags only**, not inline `#tags` written in note bodies. This is consistent with how `query_notes` already treats tags, so the two tools now agree; a vault that relies on inline-only tagging will see lower counts than the old CLI-backed `list_tags` reported.
  - **(b) `setProperty` no longer registers new property types in `.obsidian/types.json`.** The old CLI path let Obsidian's Properties view learn a new property's type automatically; `FsVaultProvider` writes the YAML value and stops there. A property introduced via `set_property` may show as "unknown type" in Obsidian's UI until edited once from inside the app.
  - **(c) `createNote` applies no Obsidian templates.** Core Templates / Templater expansion required Obsidian; callers must now pass fully-formed `content` (this was already the documented contract — see `docs/architecture/disk-write-path.md` — but is restated here as a divergence from what the CLI-backed `create` subcommand could do when combined with Obsidian's template system).

## Alternatives considered

- **Keep ADR-0007's split (CLI for writes, disk for reads) and make the CLI optional** — rejected: a headless VPS has no CLI to fall back to, so "optional" would mean "writes never work" on the target deployment; there is no partial-credit version of this that isn't the full migration.
- **Bundle a headless/embedded Obsidian to keep CLI parity** — rejected as disproportionate: it would reintroduce a heavyweight runtime dependency (and its own daemon-availability failure mode) to preserve behavior (template expansion, `types.json` registration) that most callers of an MCP-driven agent do not need.
