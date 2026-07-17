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

- For an individual note (`set_property("Foo", ...)`) the user means `Foo.md`. Auto-appending matches `create_note`'s own behavior and is what lets `resolveIdentifierPath` (`FsVaultProvider`) turn a bare name into a real vault-relative path instead of failing on an unresolved identifier.
- For a subtree filter (`path_prefix: "Tasks/"`) the user means the folder `Tasks/`, not a file. Appending `.md` would be wrong.
- For a batch read (`read_notes(paths: [...])`) the user is reading raw files by exact path; silently inserting `.md` would obscure typos.

## The rule

The MCP layer always resolves before any disk I/O happens. If the resolver cannot turn the input into a valid path, the tool fails with a structured error before `FsVaultProvider`/`FsVaultReader`/`FsVaultWriter` ever touch the filesystem. This is what makes `set_property("Foo", ...)` safe — the resolver turns it into `Foo.md`, and the provider either finds a matching file or fails explicitly with `NOT_FOUND`.

## What `normalizeNotePath` does _not_ do

- It does not check that the file exists. Existence is the reader's / writer's / provider's job.
- It does not change a non-`.md` extension into `.md`. If the user wrote `Foo.txt`, they meant `Foo.txt`. The auto-append is a friendliness affordance for missing extensions only.
- It does not trim whitespace itself — `trim()` is applied upstream by `normalizeVaultPath`.

## Treatment of trailing dots

A final segment like `Foo.` (ending in a dot) is treated as having no real extension and is promoted to `Foo..md`. The alternative — preserving `Foo.` as a literal extensionless filename — would surprise callers who mistyped, and `Foo..md` is at least syntactically valid on every supported filesystem.
