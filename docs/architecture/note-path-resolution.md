# Note Path Resolution

How MCP tools turn user-supplied path-or-name inputs into vault-relative POSIX paths before any I/O, and how `[[wikilink]]` targets found inside notes are resolved to the notes they point at.

## Three normalizers, three purposes

| Function                                                      | Used by                                                                                                                                                        | Purpose                                                                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalizeVaultPath(raw)` (in `src/lib/obsidian/paths.ts`)    | `read_notes` (per-element), subtree filters (`path_prefix`, `exclude_path_prefix` via `normalizePrefixList`)                                                   | Validate a vault-relative POSIX path. Rejects empty / absolute / `..`. Does **not** auto-append any extension — preserves the user's input verbatim.            |
| `normalizeScanPrefix(raw)` (same file)                        | Subtree-prefix accessors that allow "the whole vault" inputs                                                                                                   | Returns `''` for whole-vault inputs (`undefined`, `''`, `'.'`, `'./'`); otherwise strips leading `./` and trailing `/`. No `..` rejection — callers apply that. |
| `normalizeNotePath(raw)` (in `src/lib/obsidian/note-path.ts`) | Every tool that takes a `path` for an _individual note_ — `create_note`, `edit_note`, `set_property`, `remove_property`, `get_note_links`, `get_similar_notes` | Wraps `normalizeVaultPath` then auto-appends `.md` when the final segment has no extension.                                                                     |

## Why three

A vault-relative path can mean three different things to a caller — a single note, a subtree filter, or a batch entry — and each has a different "missing extension" intent:

- For an individual note (`set_property("Foo", ...)`) the user means `Foo.md`. Auto-appending matches `create_note`'s own behavior and is what lets `FsVaultProvider`'s two resolution modes (`resolveExisting` / `resolveNew`, see [`vault-provider.md`](./vault-provider.md#identifier-shape)) turn a bare name into a real vault-relative path instead of failing on an unresolved identifier.
- For a subtree filter (`path_prefix: "Tasks/"`) the user means the folder `Tasks/`, not a file. Appending `.md` would be wrong.
- For a batch read (`read_notes(paths: [...])`) the user is reading raw files by exact path; silently inserting `.md` would obscure typos.

## The rule

The MCP layer always resolves before any disk I/O happens. Every write tool does it through the single `resolveIdentifier(name, path)` in `src/modules/operations/tool-helpers.ts`, which runs `normalizeNotePath` on the `path` branch; if the resolver cannot turn the input into a valid path, the tool fails `INVALID_ARGUMENT` before `FsVaultProvider` or `FsVaultReader` ever touch the filesystem. This is what makes `set_property("Foo", ...)` safe — the resolver turns it into `Foo.md`, and the provider either finds a matching file or fails explicitly with `NOT_FOUND`.

## What `normalizeNotePath` does _not_ do

- It does not check that the file exists. Existence is the reader's or the provider's job.
- It does not change a non-`.md` extension into `.md`. If the user wrote `Foo.txt`, they meant `Foo.txt`. The auto-append is a friendliness affordance for missing extensions only.
- It does not trim whitespace itself — `trim()` is applied upstream by `normalizeVaultPath`.

## Treatment of trailing dots

A final segment like `Foo.` (ending in a dot) is treated as having no real extension and is promoted to `Foo..md`. The alternative — preserving `Foo.` as a literal extensionless filename — would surprise callers who mistyped, and `Foo..md` is at least syntactically valid on every supported filesystem.

## Wikilink targets: `BasenameIndex`

Links written _inside_ notes go through a different resolver: `buildBasenameIndex(paths)` in `src/lib/obsidian/link-resolver.ts`, built over the scoped scan (see [`vault-scope.md`](./vault-scope.md)). One index serves every link-aware surface, so they always agree on what a link points at:

| Consumer                                                                                              | Through                                                |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `get_note_links` edges; `backlink_count` on `search_notes`, `query_notes`, `get_vault_overview`      | `WikilinkGraphIndex` ([`wikilink-graph.md`](./wikilink-graph.md)) |
| `get_similar_notes` `forward_link` candidates                                                         | `getNoteLinks` over the semantic backend's snapshot index |
| `name`-addressed writes (`edit_note`, `set_property`, `remove_property`)                              | `resolveNoteName` (`resolveAll`, ambiguity → `AMBIGUOUS_MATCH`) |

### Target normalisation first

`normalizeWikilinkTarget` strips what Obsidian renders but does not resolve: everything from the first `#` (heading / block anchor) or `|` (alias). Inside a markdown table cell Obsidian escapes the alias separator as `\|` (`[[j-doe\|Jane Doe]]`), so a backslash directly before that first `|` is part of the separator and is dropped too — the target is `j-doe`, never `j-doe\`.

### Resolution order

First step that yields a hit wins:

1. **Exact path.** The target names a scanned file verbatim, or does so once `.md` is appended (`Teams/_index` → `Teams/_index.md`).
2. **Unique suffix** — path-form targets (containing `/`) only. Obsidian lets a note link to `[[Teams/_index]]` from inside `GrowPM/` and resolves it to `GrowPM/Teams/_index.md` as long as that is the only note whose path ends with `/Teams/_index.md`. The index does the same: a `/`-delimited tail lookup, whole segments only (`SubTeams/_index` never matches `Teams/_index`). Several candidates mean the link is **ambiguous**: `resolve()` returns `null` and the edge stays `resolved: false`, while `resolveAll()` lists the candidates sorted so a name-addressed write can report them. Guessing here would attach backlinks to the wrong note.
3. **Basename** — bare targets only. `[[_index]]` matches every note named `_index.md`; `resolve()` keeps the lexicographically smallest path (deterministic, and what Obsidian's "shortest path when possible" setting usually produces), `resolveAll()` lists them all.

A bare target never falls through to suffix matching, and a path-form target never falls through to basename matching: `[[Other/Foo]]` with only `A/Foo.md` in the vault is unresolved, not `A/Foo.md`.

### What the index does _not_ do

- No case folding — Obsidian matches links case-insensitively; the index does not (yet).
- No alias or `id` frontmatter lookup — a target is a path or a basename, nothing else.
- No cross-vault resolution — each vault builds its own index over its own scan.
