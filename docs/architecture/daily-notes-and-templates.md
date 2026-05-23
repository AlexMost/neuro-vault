# Daily Notes & Templates — MCP-side preflight and renderer

Why these two unrelated features live in one architecture doc: both are places where `obsidian-cli` exhibits the same failure mode — a success-shaped return with no write to disk, or an unintended write to vault root. The defense in both cases is to do the work at the MCP layer rather than delegate to the CLI.

## `read_daily`: Daily Notes preflight

`read_daily`'s implementation calls `obsidian-cli daily:path` and `daily:read`, both of which delegate to Obsidian's Daily Notes core plugin. On a vault where the plugin has never been configured, the plugin's default behavior is to materialize today's note at the vault root with the default `YYYY-MM-DD.md` filename, returning a path that points there. The MCP tool then reads it and returns a stub — but a 0-byte file has been created as a side effect, and the user's vault now has noise in its root.

`src/lib/obsidian/daily-notes-config.ts` reads `.obsidian/daily-notes.json` directly and throws `DAILY_NOTES_NOT_CONFIGURED` when the file is missing, malformed, or its `folder` is empty. The `read_daily` handler runs this preflight before calling the provider, so the CLI is never invoked on a misconfigured vault. There is no fallback or auto-create — the user is told to configure the plugin and retry.

## `create_note(template:)`: in-process rendering

The CLI's `create` subcommand accepts a `template=` token but appears to silently drop it under conditions the upstream behavior does not document — the file is not written, and the CLI exits 0. The original bug report described this as "the most dangerous of the four — silent in pipelines".

`src/lib/obsidian/template-renderer.ts` resolves the template (by name via `.obsidian/templates.json` or by explicit path), reads it via `fs`, applies Core Templates substitutions (`{{title}}`, `{{date}}`, `{{date:FORMAT}}`, `{{time}}`, `{{time:FORMAT}}`), and returns the rendered body. The `create_note` handler then passes the result as `content=` to the CLI. The CLI never sees `template=`.

Date and time substitutions use **UTC** components rather than local time. Obsidian's own Core Templates uses local time, so a user whose `{{time}}` is near a UTC boundary will see a different value than they would in Obsidian directly. The trade-off keeps the renderer deterministic across CI and server timezones; callers who need local-time rendering can render the template themselves and pass the result via `content=`.

### Templater fail-fast

Obsidian's [Templater](https://silentvoid13.github.io/Templater/) community plugin adds an entirely different template language (`<% tp.date.now() %>`, `<%* tp.user.foo() %>`) that requires a JavaScript-style evaluator. The renderer does not implement Templater — instead, a literal substring scan for `<%` rejects such templates with `TEMPLATE_UNSUPPORTED`, naming Templater explicitly and pointing to the `content=` workaround. Implementing a Templater evaluator is a research spike, not a bug fix; until that ships, the contract is "Core Templates only".

## The post-write existence check

`ObsidianCLIProvider.createNote` accepts `vaultRoot`, and after a successful CLI return it `fs.stat`s the target path. `ENOENT` yields `CREATE_FAILED`. This guards both the template path (where the renderer should already have caught the issue, but defense-in-depth wins) and any future regression in the CLI's `create` behavior.

When `vaultRoot` is undefined (legacy unit tests that construct the provider directly), the check is skipped. In production `vaultRoot` is always threaded through `VaultRegistry`, so the check is always active.
