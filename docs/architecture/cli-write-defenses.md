# MCP-side defenses against silent `obsidian-cli` failures

Two related defenses live here because they share a failure mode: `obsidian-cli` returns success-shaped output (exit 0) but the on-disk effect is wrong — either nothing written, or a stub written at the vault root instead of where the user asked. The defense in both cases is to do the validation at the MCP layer instead of trusting the CLI's return.

## `read_daily`: Daily Notes preflight

`read_daily`'s implementation calls `obsidian-cli daily:path` and `daily:read`, both of which delegate to Obsidian's Daily Notes core plugin. On a vault where the plugin has never been configured, the plugin's default behavior is to materialize today's note at the vault root with the default `YYYY-MM-DD.md` filename, returning a path that points there. The MCP tool then reads it and returns a stub — but a 0-byte file has been created as a side effect, and the user's vault now has noise in its root.

`src/lib/obsidian/daily-notes-config.ts` reads `.obsidian/daily-notes.json` directly and throws `DAILY_NOTES_NOT_CONFIGURED` when the file is missing, malformed, or its `folder` is empty. The `read_daily` handler runs this preflight before calling the provider, so the CLI is never invoked on a misconfigured vault. There is no fallback or auto-create — the user is told to configure the plugin and retry.

## `create_note`: post-write existence check

`ObsidianCLIProvider.createNote` accepts `vaultRoot`, and after a successful CLI return it `fs.stat`s the target path. `ENOENT` yields `CREATE_FAILED`. The most reproducible cause of this failure mode is a vault-name mismatch between `--vault` and what Obsidian shows under "Manage vaults", but it guards against any future regression in the CLI's `create` behavior.

When `vaultRoot` is undefined (legacy unit tests that construct the provider directly), the check is skipped. In production `vaultRoot` is always threaded through `VaultRegistry`, so the check is always active.

## Why `create_note` does not handle templates

An earlier draft of this defense had the MCP server resolve and render Obsidian templates in-process (Core Templates substitutions, Templater fail-fast). That was dropped: templating is the caller's job. `create_note` accepts only `content` — raw markdown for the note body and frontmatter. If a caller wants a template applied, it renders the template itself (Obsidian Core Templates, Templater, or anything else) and passes the result as `content`. This keeps the MCP server narrowly responsible for "write this content to this path" and avoids reimplementing pieces of Obsidian's plugin ecosystem.
