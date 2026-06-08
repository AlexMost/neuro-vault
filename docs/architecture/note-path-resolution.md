# Note Path Resolution

How MCP tools turn user-supplied path-or-name inputs into vault-relative POSIX paths before any I/O.

## Three normalizers, three purposes

| Function                                                      | Used by                                                                                                                                                        | Purpose                                                                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalizeVaultPath(raw)` (in `src/lib/obsidian/paths.ts`)    | `read_notes` (per-element), subtree filters (`path_prefix`, `exclude_path_prefix` via `normalizePrefixList`)                                                   | Validate a vault-relative POSIX path. Rejects empty / absolute / `..`. Does **not** auto-append any extension — preserves the user's input verbatim.            |
| `normalizeScanPrefix(raw)` (same file)                        | Subtree-prefix accessors that allow "the whole vault" inputs                                                                                                   | Returns `''` for whole-vault inputs (`undefined`, `''`, `'.'`, `'./'`); otherwise strips leading `./` and trailing `/`. No `..` rejection — callers apply that. |
| `normalizeNotePath(raw)` (in `src/lib/obsidian/note-path.ts`) | Every tool that takes a `path` for an _individual note_ — `create_note`, `edit_note`, `set_property`, `remove_property`, `get_note_links`, `get_similar_notes` | Wraps `normalizeVaultPath` then auto-appends `.md` when the final segment has no extension.                                                                     |

## Why three

A vault-relative path can mean three different things to a caller — a single note, a subtree filter, or a batch entry — and each has a different "missing extension" intent:

- For an individual note (`set_property("Foo", ...)`) the user means `Foo.md`. Auto-appending matches `create_note`'s implicit behavior (where `obsidian-cli`'s `create` subcommand appended `.md` itself) and is the only behavior that prevents `obsidian-cli` from silently falling through to Daily Notes plugin fallbacks when given an unresolved identifier.
- For a subtree filter (`path_prefix: "Tasks/"`) the user means the folder `Tasks/`, not a file. Appending `.md` would be wrong.
- For a batch read (`read_notes(paths: [...])`) the user is reading raw files by exact path; silently inserting `.md` would obscure typos.

## The rule

MCP layer always resolves; `obsidian-cli` never sees an unresolved identifier. If the resolver cannot turn the input into a valid path, the tool fails with a structured error before the CLI is invoked. This is what makes `set_property("Foo", ...)` safe — the resolver turns it into `Foo.md`, the CLI receives a path that either matches an existing file or fails explicitly, and the historical "0-byte stub at vault root" failure mode cannot happen.

## What `normalizeNotePath` does _not_ do

- It does not check that the file exists. Existence is the reader's / writer's / CLI's job.
- It does not change a non-`.md` extension into `.md`. If the user wrote `Foo.txt`, they meant `Foo.txt`. The auto-append is a friendliness affordance for missing extensions only.
- It does not trim whitespace itself — `trim()` is applied upstream by `normalizeVaultPath`.

## Treatment of trailing dots

A final segment like `Foo.` (ending in a dot) is treated as having no real extension and is promoted to `Foo..md`. The alternative — preserving `Foo.` as a literal extensionless filename — would surprise callers who mistyped, and `Foo..md` is at least syntactically valid on every supported filesystem.
