# ADR-0007 — obsidian-cli as the vault write path; reads from disk

- **Status**: Superseded by [ADR-0009](0009-disk-direct-vault-operations.md)
- **Date**: 2026-06-08

## Context

Vault operations split into writes (create/edit notes, set/remove frontmatter properties, append to the daily note) and reads (batch note bodies, frontmatter, tags). Writes ideally go through Obsidian itself so the app's link index, daily-notes plugin, and file conventions stay consistent — rather than mutating `.md` files behind the app's back. Reads, by contrast, do not need the app: the files are right there on disk.

## Decision

Route vault **writes** through the `obsidian` CLI behind a `VaultProvider` interface (`ObsidianCLIProvider`), so handlers call `provider.createNote(...)` etc. and never touch `child_process` or build CLI tokens themselves. Route batch note **reads** straight to disk via a separate `VaultReader` (`FsVaultReader`) — no CLI round-trip, and reads work even when Obsidian is not running. Because the CLI can return success-shaped output while the on-disk effect is wrong, the MCP layer adds defenses (`create_note` post-write `fs.stat`; `read_daily` preflight on `.obsidian/daily-notes.json`) rather than trusting the CLI's exit code.

## Consequences

- Writes stay consistent with Obsidian's own bookkeeping; the provider is a thin shell, swappable for a REST/plugin backend without touching handlers.
- Reads are fast and available offline (Obsidian need not be running); `query_notes` and `read_notes` read from disk.
- The CLI is an external dependency with the failure modes in ADR-0003/ADR-0004; the silent-success failure mode is specifically guarded at the MCP layer (see `docs/architecture/disk-write-path.md`, which now documents this history alongside the disk-direct behavior that superseded it — [ADR-0009](0009-disk-direct-vault-operations.md)).

## Alternatives considered

- **All operations through the CLI** — uniform, but pays a process spawn for every read and breaks when Obsidian is closed; rejected once reads moved to `FsVaultReader`.
- **All operations direct to disk** — fast, but bypasses Obsidian's link/daily-note bookkeeping on writes and risks corrupting the app's view of the vault; rejected for writes.
