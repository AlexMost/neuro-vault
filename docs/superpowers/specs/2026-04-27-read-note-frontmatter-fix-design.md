---
date: 2026-04-27
status: accepted
---

# read_note frontmatter parsing

## Problem

`read_note` returns the YAML frontmatter block in the `path` field instead of the vault-relative path; `content` happens to look right. Reproduced on 2026-04-27 with `read_note(path: "Projects/neuro-vault.md")`.

Root cause: `ObsidianCLIProvider.parseReadOutput` splits stdout on the first `\n---\n` and assumes the prefix is the path and the suffix is the body. The `obsidian read` command actually returns **only the raw note content** — frontmatter + body, no path prefix. The `\n---\n` then lines up with the closing fence of the YAML frontmatter, so `path` = the YAML block and `content` = the body. Verified by running `obsidian read path=AGENTS.md` directly.

The same parser is reused by `readDaily`, so `read_daily` has the identical bug. `edit_note` and `append_daily` write content but never parse a read response, so they are not affected.

## Goals

- `read_note` returns the actual vault-relative path of the note.
- Frontmatter is returned parsed, in a separate `frontmatter` field, not embedded as raw YAML in another field.
- `content` contains only the body — frontmatter block stripped.
- Same shape for `read_daily`.
- Existing error mapping (`NOT_FOUND`, `CLI_TIMEOUT`, etc.) is unchanged.

## Non-goals

- Cleaning up `edit_note` / `append_daily` response shape — they don't return content.
- Wider tool naming standardization — tracked separately in _Standardize neuro-vault MCP tool parameter naming_.
- Backward-compatible response shape. The current `path` value is a literal bug; we treat the change as a fix, not a breaking change.

## Design

### Response shape

```ts
interface ReadNoteResult {
  path: string;
  frontmatter: Record<string, unknown> | null;
  content: string;
}

interface DailyNoteResult {
  path: string;
  frontmatter: Record<string, unknown> | null;
  content: string;
}
```

- `path` — vault-relative path; never empty in success path.
- `frontmatter` — parsed YAML object when present and valid; `null` when no frontmatter or YAML failed to parse.
- `content` — note body without the leading frontmatter block. When parsing failed, `content` keeps the raw input (frontmatter included) so callers can recover the source text.

### Path resolution

The CLI's `read` command does not echo back the path, so the provider derives it itself:

- Identifier `kind: 'path'` → use `value` directly.
- Identifier `kind: 'name'` → call `obsidian file file=<name>` first; that command prints tab-separated `key<TAB>value` lines, the first of which is `path<TAB><vault-relative-path>`. Parse that, then call `obsidian read file=<name>`.

For `read_daily` we already know how to get the path: `obsidian daily:path` returns the path on its own, and `obsidian daily:read` returns the content. Two calls.

The cost of the extra call is acceptable. `read_note` was never a hot-path tool, and resolving once per call keeps the behavior straightforward.

### Frontmatter parsing

Use the `yaml` npm package (modern, ESM, MIT, no transitive deps) to parse the YAML block. The note content has frontmatter when:

1. stdout starts with `---` followed by EOL, AND
2. there is a closing line containing only `---` (with optional trailing whitespace).

Otherwise the whole stdout is `content`, frontmatter is `null`.

Parse logic, expressed as a single helper:

```ts
function splitFrontmatter(raw: string): {
  frontmatter: Record<string, unknown> | null;
  content: string;
};
```

- No frontmatter delimiters → `{ frontmatter: null, content: raw }`.
- Delimiters present, YAML parses to an object → `{ frontmatter, content: <body> }`.
- Delimiters present, YAML fails to parse, OR parses to a non-object (string, number, list) → `{ frontmatter: null, content: raw }` and the failure is logged once via `console.warn` (stderr in the MCP context). The note content is preserved unmolested so callers can still see what's there.

### Architectural location

Frontmatter parsing is a property of how the operations module presents notes; it is **not** a vault-provider concern. The `vault-provider.md` doc explicitly states "It does not parse markdown, frontmatter, or block structure."

To keep that boundary clean we place the parser in a dedicated file `src/modules/operations/frontmatter.ts` exporting `splitFrontmatter`. The `ObsidianCLIProvider` calls it as the last step of `readNote` / `readDaily`. The interface change (`ReadNoteResult`, `DailyNoteResult` gaining `frontmatter`) does cross the provider boundary — which is fine: the boundary is "no parsing logic in the provider"; returning a structured shape is consistent with everything else the provider already does (`getTag`, `listProperties`).

We will update `docs/architecture/vault-provider.md` to reflect that the provider's read methods now return parsed frontmatter, and explain why this is one acknowledged exception (frontmatter is structured metadata, not free-form markdown).

### Error handling

- `NOT_FOUND`, `CLI_TIMEOUT`, etc. — unchanged. Still mapped from CLI stderr.
- Bad YAML — does not throw; `frontmatter: null`, `content: raw`, single warning to stderr.
- `obsidian file file=<name>` for path resolution — if the resolution call fails (e.g., `NOT_FOUND`), surface that error directly. We don't fall back to reading first; failing fast is better than returning content with a wrong/empty path.

## Testing strategy

`test/operations/obsidian-cli-provider.test.ts` is rewritten for the new shape:

- `readNote` with frontmatter (path identifier) — `path` matches the input, `frontmatter` is the parsed object, `content` is the body without the YAML block.
- `readNote` with frontmatter (name identifier) — provider calls `obsidian file file=<name>` first, then `obsidian read file=<name>`; result `path` matches what `file` returned.
- `readNote` with no frontmatter — `frontmatter: null`, `content` equals stdout.
- `readNote` with broken YAML — `frontmatter: null`, `content` equals stdout, no throw.
- `readNote` with `NOT_FOUND` — error code preserved.
- `readDaily` — equivalent coverage; calls `daily:path` then `daily:read`.

A new `test/operations/frontmatter.test.ts` unit-tests `splitFrontmatter` directly: empty input, no delimiters, valid YAML, malformed YAML, YAML parsing to a scalar, frontmatter with trailing whitespace on closing fence, frontmatter immediately followed by EOF (no body).

Existing tests for error mapping and other commands stay as is; they don't depend on the parser.

## Definition of Done

- All unit tests in `test/operations/` pass with the new behavior.
- `npm test`, `npm run lint`, and `npx tsc --noEmit` are green.
- `docs/architecture/vault-provider.md` updated to mention the structured `frontmatter` field and the exception to "the provider does not parse markdown."
- Tool descriptions in `tools.ts` updated: `read_note` and `read_daily` advertise `{ path, frontmatter, content }`.
- Smoke test on the user's vault confirms: a note with frontmatter returns proper `path`, parsed `frontmatter`, and clean `content`; a note without frontmatter returns `frontmatter: null`.
- Patch release published from `main` via `npm run release`.

## Connections

- Supersedes the implicit assumption in `docs/architecture/vault-provider.md` that `obsidian read` returns `<path>\n---\n<body>`.
- Future work: _Add batch read_notes to neuro-vault_ will reuse the new response shape directly.
- Future work: _Standardize neuro-vault MCP tool parameter naming_ may revisit `name` vs `file` once this lands.
