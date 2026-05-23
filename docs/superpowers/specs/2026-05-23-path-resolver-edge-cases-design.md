# Path-resolver edge cases & silent failures

Date: 2026-05-23
Status: Approved
Source: `Tasks/Fix path-resolver edge cases and silent failures in neuro-vault.md` (vault)

## Revision — 2026-05-23 (mid-implementation)

The original spec proposed an in-process template renderer for `create_note(template:)`. That was dropped before merge: templating is the caller's responsibility, not the MCP server's. `create_note` accepts `content` only; if a caller wants a template applied, it renders the template itself (Obsidian Core Templates, Templater, or anything else) and passes the result as `content`.

Practical consequences for what shipped:

- `template` parameter removed from `create_note`'s schema and `CreateNoteInput` provider type.
- No `src/lib/obsidian/template-renderer.ts` module; no `applyCoreTemplateSubstitutions`, no `resolveAndRenderTemplate`.
- Error codes `TEMPLATE_NOT_CONFIGURED`, `TEMPLATE_NOT_FOUND`, `TEMPLATE_UNSUPPORTED` are not added.
- `ObsidianCLIProvider.createNote` still drops any historical `template=` token by virtue of not having that field on its input — but no special handling of templates exists anywhere.
- The architecture doc `docs/architecture/daily-notes-and-templates.md` was renamed to `cli-write-defenses.md`, scoped to the two remaining defenses (Daily Notes preflight, post-write existence check) plus a short "why we don't handle templates" rationale.

Everything else from the original spec — `normalizeNotePath` and its wiring, Daily Notes preflight, post-write existence check, vault-name regex error message — ships as described.

The original text below is preserved for history; treat it as superseded where it conflicts with this revision.

## Goal

Eliminate four classes of silent failure in `neuro-vault` MCP tools where a call returns success-shaped output but the on-disk effect is wrong:

1. `read_daily` triggers Obsidian's Daily Notes plugin and creates a 0-byte stub in the vault root when the plugin is not configured.
2. `create_note(template: ...)` returns `{ path }` without writing anything to disk — `obsidian-cli` silently drops the `template=` token.
3. `set_property` (and, less critically, `edit_note`) accept paths missing the `.md` extension; `set_property` then falls through `obsidian-cli`'s identifier resolver into the Daily Notes plugin fallback (writing a 0-byte stub at vault root) while reporting `ok: true`.
4. The vault-name regex `^[a-zA-Z0-9_-]{1,64}$` rejects names with spaces / Unicode silently from the user's perspective — the error message does not name the pattern explicitly.

#1 and #3 share a single root cause: when our MCP wrapper hands `obsidian-cli` an identifier it cannot resolve to an existing note in the active vault, the CLI silently delegates to whatever the active Daily Notes plugin would do (often: create a new file under whatever folder the plugin is pointing at — vault root, if unconfigured). The fix is to do the path resolution at the MCP layer so the CLI never receives an ambiguous identifier.

#2 is a separate class — a silent success without a write. Independent fix.

#4 is a copy edit on one error message + a short README mention.

This spec covers all four under one release because the architectural change (uniform path resolution in the MCP wrapper) is the same scope of work whether we ship 1, 2, or 4 fixes alongside it.

## Scope

Five concrete changes:

1. **Daily Notes preflight.** Before any `read_daily` call reaches `obsidian-cli`, read `.obsidian/daily-notes.json` from the vault directory. If the file is missing, malformed, or its `folder` is empty/unset, throw structured `DAILY_NOTES_NOT_CONFIGURED`. The CLI is never invoked, so it cannot create a stub.
2. **Note-path normalization auto-appends `.md`.** A new helper `normalizeNotePath(raw)` wraps the existing `normalizeVaultPath` and appends `.md` to any path whose final segment has no extension. Wired into every tool handler that takes a `path` referring to an _individual note_ (create_note, edit_note, set_property, read_property, remove_property, get_similar_notes). Tools that take subtree prefixes (`path_prefix`, `exclude_path_prefix`, `paths` for `read_notes`) keep using `normalizeVaultPath` / `normalizeScanPrefix` unchanged.
3. **`create_note(template)` rendered in-process.** Drop the unreliable `template=` pass-through to `obsidian-cli`. When `template` is given, the MCP server resolves the template file (by name via `.obsidian/templates.json` or by explicit path), reads it via `fs`, applies Core Templates substitutions (`{{title}}`, `{{date}}`, `{{date:FORMAT}}`, `{{time}}`, `{{time:FORMAT}}`), and passes the rendered string to `obsidian-cli` as `content=`. Templater syntax (`<% ... %>`) is detected and fails fast with `TEMPLATE_UNSUPPORTED`.
4. **Post-write existence check on `create_note`.** After `obsidian-cli create` returns, `fs.stat` the target path. If the file does not exist, throw `CREATE_FAILED`. Catches `template=`-style silent failures and any future regression where the CLI returns 0 without writing.
5. **Vault-name regex in the error message + README.** `src/config.ts:24` error string and a one-line mention under the README installation section.

### Out of scope

- Replacing `obsidian-cli` as the backend for `create_note`'s actual file write. The CLI's `create` subcommand works correctly when given `content=` — the broken path is `template=`. Templates are diverted; the rest stays.
- Replacing `obsidian-cli` for `read_daily`'s actual read. Once the preflight guarantees the plugin is configured, the CLI's `daily:read` is reliable.
- Templater (`<% ... %>`) rendering. Fail-fast with a structured error is the contract; implementing a JS evaluator is a research spike, not this change.
- Auto-appending `.md` in `read_notes`. Its `paths` parameter is a batch of vault-relative paths read directly from disk — the convention is documented as POSIX paths with extensions, and silently inserting `.md` would obscure typos.

## Architecture

Three new modules in `src/lib/obsidian/`, all pure and testable without spawning processes:

### `note-path.ts` (new)

```ts
// Vault-relative POSIX path to an individual note. Auto-appends `.md` if the
// final segment has no extension. Delegates absolute/.. rejection to
// normalizeVaultPath so all path validation lives in one place.
export function normalizeNotePath(raw: string): string;
```

Behavior:

- `"Foo"` → `"Foo.md"`.
- `"Foo.md"` → `"Foo.md"` (idempotent).
- `"Tasks/Foo"` → `"Tasks/Foo.md"`.
- `"Tasks/Foo.md"` → `"Tasks/Foo.md"`.
- `"Tasks/Foo.bar"` → `"Tasks/Foo.bar"` (caller asked for a non-`.md` extension; we don't override).
- `"Tasks/Foo.bar.baz"` → `"Tasks/Foo.bar.baz"` (final segment has an extension).
- `"./Foo"` / `"Foo/"` — leading `./` stripped and trailing `/` rejected by `normalizeVaultPath` upstream; if the result has no extension, `.md` is appended.
- Errors from `normalizeVaultPath` (empty, absolute, `..`) propagate unchanged.

Why this shape: `create_note`'s description already documents `path` as "vault-relative POSIX path"; this change makes the behavior match what readers reasonably assume — that a note path means a `.md` file. Existing callers passing `"Foo.md"` are unaffected.

Wiring (4 files, all in `src/modules/operations/`):

| File                          | Change                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `tools/create-note.ts:66`     | `passthrough.path = normalizeNotePath(input.path)`                                                              |
| `tools/edit-note.ts:83`       | `return normalizeNotePath(input.path)` in the path branch of `resolveToPath`                                    |
| `tool-helpers.ts:38`          | `return { kind: 'path', value: normalizeNotePath(pathArg!) }` in `resolveIdentifier` (covers the 3 property tools + any future identifier-based note tool) |
| `tools/get-similar-notes.ts`* | `normalizePath` → `normalizeNotePath` if the tool resolves an individual note path (verify during implementation) |

\*verified during implementation; if not applicable, the line is dropped.

### `daily-notes-config.ts` (new)

```ts
// Reads .obsidian/daily-notes.json from the vault directory and returns the
// configured folder (vault-relative) and format.
//
// Throws ToolHandlerError('DAILY_NOTES_NOT_CONFIGURED') when the file is
// missing, unreadable, malformed JSON, or `folder` is missing/empty/blank.
//
// Pure I/O; the FsReadFile shape mirrors VaultWriter for the same DI story.
export interface DailyNotesConfig {
  folder: string;  // vault-relative POSIX path, no trailing slash
  format: string;  // moment.js format string, default 'YYYY-MM-DD'
}

export async function readDailyNotesConfig(
  vaultRoot: string,
  readFile?: FsReadFile,
): Promise<DailyNotesConfig>;
```

Default `format` per Obsidian: `'YYYY-MM-DD'` when the field is absent. Treat an empty string the same way.

Wiring: `tools/read-daily.ts` calls `readDailyNotesConfig(entry.config.path)` _before_ `entry.provider.readDaily()`. If the preflight throws, the CLI is never invoked.

### `template-renderer.ts` (new)

Two responsibilities — resolution and substitution — in one file because both are small and only used together by `create_note`.

```ts
export interface ResolvedTemplate {
  path: string;     // vault-relative POSIX path to the template .md file
  rendered: string; // template content with {{...}} substitutions applied
}

// Resolves `template` to a vault-relative path. Two acceptance forms:
//   - Looks like a path (contains '/' OR ends with '.md'): used as-is after
//     normalizeNotePath.
//   - Otherwise: treated as a template name; resolved against the folder in
//     .obsidian/templates.json with '.md' appended.
//
// Reads the template via fs (vault-rooted), detects Templater syntax, applies
// Core Templates substitutions against the target note's title and the
// current timestamp, returns the rendered string.
//
// Errors:
//   TEMPLATE_NOT_CONFIGURED — name-form used and templates.json is
//     missing/empty.
//   TEMPLATE_NOT_FOUND      — resolved file does not exist (ENOENT).
//   TEMPLATE_UNSUPPORTED    — body contains `<%` (Templater).
//
// The title input is derived by the caller from the create_note input
// (basename of path, or `name`, stripped of any trailing `.md`).
export async function resolveAndRenderTemplate(input: {
  vaultRoot: string;
  template: string;
  title: string;
  now?: Date;            // override for tests
  readFile?: FsReadFile;
}): Promise<ResolvedTemplate>;
```

#### Core Templates substitutions

Implemented as a function `applyCoreTemplateSubstitutions(body, { title, now })`:

| Token              | Replacement                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{title}}`        | The new note's title.                                                                                                                        |
| `{{date}}`         | `YYYY-MM-DD` of `now`.                                                                                                                       |
| `{{date:FORMAT}}`  | `now` formatted by a minimal moment-compatible formatter — supports `YYYY MM DD HH mm ss`, including separators. Unknown tokens pass through. |
| `{{time}}`         | `HH:mm` of `now`.                                                                                                                            |
| `{{time:FORMAT}}`  | Same formatter as `{{date:FORMAT}}`.                                                                                                         |

The formatter is intentionally small — only the tokens listed above. Anything outside that set passes through unchanged; the cost of supporting one more token is one regex, and the cost of getting it wrong (silently miscounting milliseconds, say) is worse than passing through.

#### Templater detection

A literal substring scan for `<%`. Cheap, no false positives in core templates (the sequence is not valid in YAML frontmatter, body markdown, or HTML embedded in markdown — it would already be invalid). False negatives are impossible: any Templater directive opens with `<%`.

#### create_note flow

```
input.template defined
  ↓
resolveAndRenderTemplate({ template, title: derived, vaultRoot })
  ↓
provider.createNote({ name|path, content: rendered, overwrite })
  ↓
post-write fs.stat(absPath) — throw CREATE_FAILED if ENOENT
```

When `input.content` is provided instead of `template`, the rendering step is skipped (no change to current behavior) and the post-write stat still runs.

### `obsidian-cli-provider.ts` changes

Two additions, both in `createNote`:

1. Accept a new internal contract: when the handler passes `content`, the `template` token is **not** forwarded to the CLI (it never was useful; this just removes dead code paths).
2. After `await this.runCommand('create', tokens)`, `fs.stat` the resolved absolute path. If `ENOENT`, throw:

   ```ts
   new ToolHandlerError(
     'CREATE_FAILED',
     `Obsidian CLI returned success but ${input.path ?? input.name} was not written to disk. ` +
       `This usually means a template or content rejection that the CLI swallowed.`,
     { details: { name: input.name, path: input.path } },
   );
   ```

   Stat requires `vaultRoot`. The provider currently has only `vaultName`; we widen `ObsidianCLIProviderOptions` to include `vaultRoot?: string` and thread it from `VaultRegistry`. When absent (legacy tests), the stat is skipped — preserving current test ergonomics while making it active in production.

### `read-daily.ts` changes

```ts
handler: async (input) => {
  const entry = resolveVault(input, registry, { tool: 'read_daily' });
  await readDailyNotesConfig(entry.config.path); // preflight; throws if unconfigured
  const daily = await entry.provider.readDaily();
  // ... unchanged from here
}
```

The preflight's return value is intentionally unused at this layer — we just need it to throw on the bad case. Downstream consumers can extend later if folder/format are useful.

### `set_property` description note

Today's description says "Provide either `name` (wikilink-style) or `path` (vault-relative)." Once `normalizeNotePath` is wired through `resolveIdentifier`, the description gains one sentence: "Paths without an extension are treated as `.md` notes."

The same sentence is added to `create_note`, `edit_note`, `read_property`, and `remove_property` descriptions for consistency. `get_similar_notes` if applicable.

### `config.ts` error message

Line 24, current:

```ts
`(allowed: alphanumerics, "_", "-", 1-64 chars). Rename the directory.`
```

Updated:

```ts
`(allowed pattern: /^[a-zA-Z0-9_-]{1,64}$/ — ASCII letters, digits, "_", or "-"; 1-64 chars). Rename the directory.`
```

README addition: under "Installation" / "Vault setup", a one-liner: "Vault directory names must match `^[a-zA-Z0-9_-]{1,64}$` — letters, digits, `_`, `-`. Spaces, Unicode, and other punctuation are rejected." (Exact wording finalized during implementation.)

## Error model

| Condition                                                                        | Code                          | Mapped MCP error                            |
| -------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------- |
| `read_daily` with missing/empty `.obsidian/daily-notes.json` or empty `folder`   | `DAILY_NOTES_NOT_CONFIGURED`  | Same code; user-facing message names the file and required fields. |
| `create_note(template: X)` where templates.json missing and X is a name (no `/`) | `TEMPLATE_NOT_CONFIGURED`     | Same code.                                  |
| `create_note(template: X)` where the resolved file is missing                    | `TEMPLATE_NOT_FOUND`          | Same code.                                  |
| `create_note(template: X)` where the file contains `<%`                          | `TEMPLATE_UNSUPPORTED`        | Same code. Message names Templater explicitly and points to the `content=` workaround. |
| `create_note` succeeds at CLI level but file absent post-stat                    | `CREATE_FAILED`               | Same code.                                  |
| Note path without `.md` extension is auto-promoted                               | _no error_ — silent success    | Behavior change, documented in the description sentence. |
| Vault name fails regex                                                           | unchanged                     | Existing `Error` from `parseConfig`, with the new message. |

All new codes are added to `OperationsErrorCode` in `src/modules/operations/types.ts`.

## Test plan

### Unit — `normalizeNotePath`

`test/lib/obsidian/note-path.test.ts` (new):

- `"Foo"` → `"Foo.md"`.
- `"Foo.md"` → `"Foo.md"` (no change).
- `"Tasks/Foo"` → `"Tasks/Foo.md"`.
- `"Tasks/Foo.md"` → `"Tasks/Foo.md"`.
- `"Tasks/Foo.bar"` → `"Tasks/Foo.bar"` (foreign extension preserved).
- `"./Foo"` → `"Foo.md"` (leading `./` stripped, then promoted).
- `"  Foo  "` → `"Foo.md"` (trim).
- `""`, `"   "`, `"."`, `"./"` — all throw the same errors `normalizeVaultPath` throws today.
- `"/Foo"`, `"C:/Foo"` — absolute rejected.
- `"a/../b"` — `..` rejected.

### Unit — `daily-notes-config`

`test/lib/obsidian/daily-notes-config.test.ts` (new):

- File missing (ENOENT) → `DAILY_NOTES_NOT_CONFIGURED`.
- File present, malformed JSON → `DAILY_NOTES_NOT_CONFIGURED`.
- File present, valid JSON, `folder: ""` → `DAILY_NOTES_NOT_CONFIGURED`.
- File present, valid JSON, `folder` whitespace-only → `DAILY_NOTES_NOT_CONFIGURED`.
- File present, valid JSON, no `folder` key → `DAILY_NOTES_NOT_CONFIGURED`.
- File present, valid, `folder: "01 Daily"`, `format` absent → returns `{ folder: '01 Daily', format: 'YYYY-MM-DD' }`.
- File present, valid, `folder: "01 Daily"`, `format: "YYYY/MM/DD"` → returns both verbatim.
- Trailing slash on `folder` stripped: `"01 Daily/"` → `"01 Daily"`.

### Unit — `template-renderer`

`test/lib/obsidian/template-renderer.test.ts` (new):

Substitution:

- `{{title}}` → injected title.
- `{{date}}` → `2026-05-23` for `now = 2026-05-23T10:00:00Z`.
- `{{time}}` → `10:00` for the same.
- `{{date:YYYY MM DD}}` → `2026 05 23`.
- `{{time:HH-mm-ss}}` → `10-00-00`.
- Unknown token `{{foo}}` passes through unchanged.
- Multiple tokens in one document — all substituted.
- Token inside YAML frontmatter — substituted (consistent with Core Templates).

Resolution:

- `template: "daily"`, templates.json `folder: "Templates"` → reads `Templates/daily.md`.
- `template: "Templates/daily"`, templates.json absent → uses path form, reads `Templates/daily.md` (auto-`.md`).
- `template: "Templates/daily.md"` → reads as-is.
- `template: "missing"`, templates.json valid, file missing → `TEMPLATE_NOT_FOUND`.
- `template: "missing"`, templates.json absent → `TEMPLATE_NOT_CONFIGURED`.
- Body contains `<% tp.date.now() %>` → `TEMPLATE_UNSUPPORTED`.
- Body contains `<%*` (Templater execution block) → `TEMPLATE_UNSUPPORTED`.

### Integration — `create_note`

`test/operations/tools/create-note.test.ts`:

- Existing `content`-form tests continue to pass (post-stat skipped when `vaultRoot` undefined).
- New: `template: "daily"` with a real templates.json and a real `daily.md` on a tmp vault → file is written with substituted content; CLI is called with `content=<rendered>`, no `template=` token.
- New: `template` resolves but body has `<%` → `TEMPLATE_UNSUPPORTED`, CLI is never called.
- New: `vaultRoot` provided + CLI returns 0 + file missing → `CREATE_FAILED`.

### Integration — `read_daily`

`test/operations/tools/read-daily.test.ts`:

- New: vault without `.obsidian/daily-notes.json` → `DAILY_NOTES_NOT_CONFIGURED`, provider's `readDaily` is never called.
- Existing path-happy tests — fixture extended to include a valid `daily-notes.json`.

### Integration — `set_property` / `edit_note` / property tools

- Existing happy-path tests with `path: "Foo.md"` continue to pass.
- New: `path: "Foo"` (no `.md`) — call succeeds and operates on `Foo.md`. Assertion: the CLI receives `path=Foo.md` (set_property), and the writer reads/writes `Foo.md` (edit_note).
- New: `path: "Tasks/Foo"` — same, `path=Tasks/Foo.md`.
- New: `path: "Foo.txt"` — `path=Foo.txt` unchanged (foreign extension preserved); covers the principle that we promote _missing_ extensions only.

### Integration — `config`

`test/config.test.ts`:

- Existing test asserting the error message updated to include `/^[a-zA-Z0-9_-]{1,64}$/`.

### Smoke

`test/server-modules.test.ts`, `test/server-instructions.test.ts` — existing tool descriptions updated to mention `.md` auto-promotion; no behavior change in smoke.

## Documentation updates

- `docs/architecture/vault-provider.md` — extend the "What it deliberately does not do" section to note the path-normalization layer (now via `normalizeNotePath`) and the new `vaultRoot` parameter that enables post-write verification.
- `docs/architecture/` — new file `note-path-resolution.md` describing the single resolver (`normalizeNotePath` for individual notes, `normalizeVaultPath` for sub-trees, `normalizeScanPrefix` for prefixes) and the rule "MCP layer always resolves; the CLI never sees an unresolved identifier."
- `docs/architecture/` — new file `daily-notes-and-templates.md` describing the MCP-side preflight + template renderer, why they exist (silent-failure prevention), and the Templater fail-fast contract.
- `docs/guide/vault-operations.md` — under `create_note`, `set_property`, `edit_note`, `read_property`, `remove_property`: add the `.md` auto-promotion sentence and one example.
- `docs/guide/vault-operations.md` — under `create_note(template:)`: replace the existing description with the new contract (resolution by name or path, Core Templates substitution list, Templater fail-fast).
- `docs/guide/vault-operations.md` — under `read_daily`: add the `DAILY_NOTES_NOT_CONFIGURED` precondition.
- `README.md` — short vault-name regex line in the install section.
- `AGENTS.md` — MCP parameter dictionary: the `path` row footnote "`.md` is auto-appended when the final segment has no extension."

## Definition of Done

- `normalizeNotePath` exists, is consumed by every tool that takes a note `path`, and behaves per the table above.
- `read_daily` performs the Daily Notes preflight; vaults without `.obsidian/daily-notes.json` produce `DAILY_NOTES_NOT_CONFIGURED` and the CLI is never invoked.
- `create_note(template:)` renders templates in-process via `template-renderer.ts`; Templater is rejected with `TEMPLATE_UNSUPPORTED`; the `template=` token is no longer forwarded to `obsidian-cli`.
- `create_note` post-stats the written file when `vaultRoot` is available; absent files produce `CREATE_FAILED`.
- `config.ts` error message includes the regex pattern verbatim; README has a one-liner.
- Architecture docs (`vault-provider.md` update + two new files), guide docs (`vault-operations.md` + `README.md`), and AGENTS.md parameter dictionary updated.
- `npm test`, `npm run lint`, `npx tsc --noEmit` — green.
- CHANGELOG: one `feat:` entry for the path resolver consolidation and template renderer (drives a minor bump); the four bug-fix descriptions appear under it as bullet points.

## Expected impact

The task source notes four bugs surfaced "in real use of neuro-vault + Smart Connections", with #2 (`create_note(template)`) described as "the most dangerous of the four — silent in pipelines". After this change:

- `read_daily` cannot create stub files; misconfigured vaults fail loudly with a fix-it message.
- `create_note(template:)` either writes the rendered file or returns a structured error. The pipeline-silent failure mode goes away.
- `set_property("Foo", ...)` and `edit_note("Foo", ...)` operate on `Foo.md` like `create_note` does; no more 0-byte stubs at vault root.
- The vault-name rejection becomes self-explanatory the first time a user sees it, instead of requiring a code dive.
