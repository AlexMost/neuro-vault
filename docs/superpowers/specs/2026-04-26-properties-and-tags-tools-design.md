# Properties & Tags Tools — Design

**Date:** 2026-04-26
**Status:** Draft
**Source task:** `Add properties and tags tools to neuro-vault` (Batch 2)
**Predecessor spec:** [2026-04-25-vault-operations-module-design.md](./2026-04-25-vault-operations-module-design.md)

## Goal

Extend the `operations` module with full CRUD for frontmatter properties and read-only tools for tags. After Batch 1 (5 tools) added the foundation, this batch adds 6 more tools that let an LLM agent inspect and modify note metadata cheaply, without paying the token cost of reading whole notes and parsing YAML.

## Scope

### In scope

- 6 new MCP tools registered into the existing `operations` module: `set_property`, `read_property`, `remove_property`, `list_properties`, `list_tags`, `get_tag`.
- Extension of `VaultProvider` with 6 new methods, implemented in `ObsidianCLIProvider` via `child_process.execFile` to the existing `obsidian` CLI.
- New error codes: `PROPERTY_NOT_FOUND`, `TAG_NOT_FOUND`, `UNSUPPORTED_VALUE_TYPE`. Reuse existing `INVALID_ARGUMENT`, `NOT_FOUND`, `CLI_*` codes.
- Unit tests for provider, handlers, registrations; integration test count update.
- README tools-matrix and Vault Operations section updates.
- Minor version bump (1.5.x → 1.6.0).

### Out of scope

- New `metadata` module — these tools live in `operations` (one module = vault operations).
- New CLI flags or runtime config — controlled by the existing `--operations` toggle.
- Per-file `list_properties` / `list_tags` — covered by `read_note` (whole frontmatter) and `read_property` (one key) per task design rationale.
- Backlinks, search, rename, delete — separate future tasks.
- Real end-to-end tests against a live Obsidian instance (manual smoke test only, as in Batch 1).

## Architecture

No new files. The existing layout is preserved; six methods are added to each of the existing files:

```
src/modules/operations/
  vault-provider.ts          # +6 input/result types and 6 methods on VaultProvider
  obsidian-cli-provider.ts   # +6 implementations using existing runCommand()
  tool-handlers.ts           # +6 handlers with validation and type inference
  tools.ts                   # +6 zod schemas and ToolRegistration entries
  types.ts                   # +6 tool-input types, new error codes
test/operations/
  obsidian-cli-provider.test.ts  # extended
  tool-handlers.test.ts          # extended
  tools.test.ts                  # registration count 5 → 11
test/server-modules.test.ts      # tool count 9 → 15 (when both modules on)
```

`runCommand()` and `mapExecError()` in `ObsidianCLIProvider` are already generic — new commands (`property:set`, `property:read`, `property:remove`, `properties`, `tag`, `tags`) reuse them with command-specific error patterns layered on top.

## CLI commands used

Verified against `obsidian` CLI help output:

| Tool             | CLI command       | Required args                                | Optional args                                                        |
| ---------------- | ----------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| `set_property`   | `property:set`    | `name=<X>`, `value=<Y>`, target (`file`/`path`) | `type=text\|list\|number\|checkbox\|date\|datetime`                  |
| `read_property`  | `property:read`   | `name=<X>`, target (`file`/`path`)           | —                                                                    |
| `remove_property`| `property:remove` | `name=<X>`, target (`file`/`path`)           | —                                                                    |
| `list_properties`| `properties`      | —                                            | always pass `counts sort=count format=json`                          |
| `list_tags`      | `tags`            | —                                            | always pass `counts sort=count format=json`                          |
| `get_tag`        | `tag`             | `name=<X>`                                   | `verbose` (when `include_files: true`); `total` (when `false`)       |

## VaultProvider extensions

Added to `vault-provider.ts`:

```typescript
export type PropertyType = 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime';
export type PropertyValue = string | number | boolean | string[] | number[];

export interface SetPropertyInput {
  identifier: NoteIdentifier;
  name: string;
  value: PropertyValue;
  type?: PropertyType;
}

export interface ReadPropertyInput {
  identifier: NoteIdentifier;
  name: string;
}

export interface ReadPropertyResult {
  value: PropertyValue;
}

export interface RemovePropertyInput {
  identifier: NoteIdentifier;
  name: string;
}

export interface PropertyListEntry { name: string; count: number; }
export interface TagListEntry      { name: string; count: number; }

export interface GetTagInput {
  name: string;             // must NOT include leading '#'; handler strips it
  includeFiles?: boolean;   // default true
}

export interface GetTagResult {
  name: string;
  count: number;
  files?: string[];
}

export interface VaultProvider {
  // ... existing 5 methods from Batch 1 ...
  setProperty(input: SetPropertyInput): Promise<void>;
  readProperty(input: ReadPropertyInput): Promise<ReadPropertyResult>;
  removeProperty(input: RemovePropertyInput): Promise<void>;
  listProperties(): Promise<PropertyListEntry[]>;
  listTags(): Promise<TagListEntry[]>;
  getTag(input: GetTagInput): Promise<GetTagResult>;
}
```

The `NoteIdentifier` tagged union from Batch 1 is reused. Property tools accept the file via `file` or `path` only (no `name`-as-file alias) because `name` is already taken by the property name.

## ObsidianCLIProvider implementation

### Argument construction

```
setProperty({ identifier:{kind:'path',value:'Tasks/x.md'}, name:'status', value:'done', type:'text' })
  → execFile('obsidian', ['property:set', 'name=status', 'value=done', 'type=text', 'path=Tasks/x.md'])

setProperty({ ..., name:'tags', value:['a','b'], type:'list' })
  → execFile('obsidian', ['property:set', 'name=tags', 'value=a,b', 'type=list', 'path=...'])

readProperty({ identifier, name:'status' })
  → execFile('obsidian', ['property:read', 'name=status', 'path=...'])

removeProperty({ identifier, name:'status' })
  → execFile('obsidian', ['property:remove', 'name=status', 'path=...'])

listProperties()
  → execFile('obsidian', ['properties', 'counts', 'sort=count', 'format=json'])

listTags()
  → execFile('obsidian', ['tags', 'counts', 'sort=count', 'format=json'])

getTag({ name:'mcp', includeFiles:true })
  → execFile('obsidian', ['tag', 'name=mcp', 'verbose'])

getTag({ name:'mcp', includeFiles:false })
  → execFile('obsidian', ['tag', 'name=mcp', 'total'])
```

`execFile` (no shell) protects against command injection from LLM-controlled input — same guarantee as Batch 1.

### Output parsing

| Command                | Output                                       | Parser                                                                                         |
| ---------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `property:read`        | raw value as string                          | inference: `"true"`/`"false"` → boolean; numeric-only → number; multi-line stdout → list (split on `\n`, trim, drop empties); else string |
| `property:set`         | empty / confirmation                         | ignored; success on exit 0                                                                     |
| `property:remove`      | empty / confirmation / "not found"           | ignored on success; "not found" stderr is **swallowed** (idempotent)                           |
| `properties` json      | `[{name,count}, ...]`                        | `JSON.parse(stdout)` → typed                                                                   |
| `tags` json            | `[{name,count}, ...]`                        | `JSON.parse(stdout)` → typed                                                                   |
| `tag verbose`          | format not in `--help`; expected: count + file list | parsed experimentally during impl; spec contract is `{name, count, files: string[]}`. If actual format diverges, provider parser is adjusted, tests fix the behavior, this spec is updated inline. |
| `tag total`            | numeric-only stdout                          | `parseInt(stdout.trim())` → `count`                                                            |

The `property:read` parser is **best-effort**. The CLI emits the raw rendered value; for ambiguous strings (e.g. a property whose actual stored type is `text` but contents are `"42"`), we'll return `42` as a number. Clients that need ground-truth types should call `read_note` and parse frontmatter YAML themselves. This trade-off is acceptable because the dominant use case is "what's the status?" / "which tags?" — not type-perfect round-tripping.

### Error mapping additions

Added on top of Batch 1's `mapExecError`:

| Signal                                                          | Error code             | Notes                                                  |
| --------------------------------------------------------------- | ---------------------- | ------------------------------------------------------ |
| `property:read` — stderr matches `property not found`/`not set`, OR exit 0 with empty stdout | `PROPERTY_NOT_FOUND`   | exact patterns confirmed during impl smoke test        |
| `property:remove` — same patterns above                          | (swallowed)            | idempotent; handler returns `{ ok: true }`             |
| `tag` — stderr matches `tag not found`, OR `total` returns 0     | `TAG_NOT_FOUND`        | per task spec                                          |
| `properties`/`tags` — `JSON.parse` throws                        | `CLI_ERROR`            | unexpected output format                               |
| Other non-zero exits                                             | reuse Batch 1 mapping  | `NOT_FOUND` for missing files, `CLI_ERROR` otherwise   |

## Tool registrations

zod schemas in `tools.ts`:

```typescript
const propertyTargetShape = {
  file: z.string().optional(),    // wikilink-style → CLI file=
  path: z.string().optional(),    // exact vault-relative → CLI path=
};

const setPropertySchema = z.object({
  ...propertyTargetShape,
  name: z.string(),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.array(z.number()),
  ]),
  type: z.enum(['text','list','number','checkbox','date','datetime']).optional(),
});

const readPropertySchema   = z.object({ ...propertyTargetShape, name: z.string() });
const removePropertySchema = z.object({ ...propertyTargetShape, name: z.string() });

const listPropertiesSchema = z.object({});  // vault-wide only
const listTagsSchema       = z.object({});  // vault-wide only

const getTagSchema = z.object({
  name: z.string(),
  include_files: z.boolean().optional(),    // handler defaults to true
});
```

Tool descriptions:

- `set_property` — _"Set a frontmatter property on a note. Provide either `file` (wikilink-style) or `path` (vault-relative). `value` may be string/number/boolean/array — `type` is inferred from JS type unless given. For `date`/`datetime` you MUST pass `type` explicitly. Existing properties are overwritten."_
- `read_property` — _"Read a frontmatter property value from a note. Returns `{ value }`. Use `read_note` if you need the full frontmatter or accurate type information."_
- `remove_property` — _"Remove a frontmatter property from a note. Idempotent — succeeds whether or not the property existed."_
- `list_properties` — _"List all frontmatter properties used across the vault, sorted by occurrence count desc. Returns `[{name, count}]`. Useful for understanding the vault's metadata ontology."_
- `list_tags` — _"List all tags used across the vault, sorted by occurrence count desc. Returns `[{name, count}]`."_
- `get_tag` — _"Get info about one tag. Returns `{name, count}` and (by default) `files: string[]`. Pass `include_files: false` for popular tags where the file list would be large."_

## Tool handler logic

In `tool-handlers.ts`:

### Property target resolution

A new helper, `resolvePropertyTarget(file, path)`, mirrors Batch 1's `resolveIdentifier` but only accepts `file`/`path` (never the `name` alias) — required because `name` collides with property name. Both unset or both set → `INVALID_ARGUMENT`. `path` is normalized via the existing `normalizePath`.

### `set_property` type inference

Performed in the handler (not the provider) so the provider stays a thin CLI translator:

| JS value                         | Inferred `type`  |
| -------------------------------- | ---------------- |
| `string`                         | `text`           |
| `number`                         | `number`         |
| `boolean`                        | `checkbox`       |
| `Array<string \| number>`        | `list`           |
| anything else (null/undefined/object) | reject `UNSUPPORTED_VALUE_TYPE` |

Explicit `type` passed by the caller wins over inference. `date` / `datetime` require explicit `type` — the handler does not pattern-match strings like `2026-04-26`. If a string value is passed without `type`, it goes to CLI as `text`.

For arrays (inferred or explicit `list`):

- Each item is stringified (numbers → `String(item)`).
- If any stringified item contains a `,`, reject with `INVALID_ARGUMENT` (`"list items containing commas are not supported by obsidian-cli"`). This avoids silent data corruption since the CLI splits on commas.
- Otherwise items are joined with `,` to form the `value=` token.

### `get_tag` normalization

The handler strips a single leading `#` from `name` if present (LLMs commonly include it). The CLI receives the bare tag name. Internally `includeFiles` defaults to `true` when omitted.

### `read_property` value typing

The handler returns whatever the provider returns. No additional logic. The provider's best-effort inference (boolean → number → list → string) is the contract.

### `remove_property` idempotency

The handler always returns `{ ok: true }` on a successful provider call — including the case where the provider swallows a "property not found" error. The handler does not distinguish removed-vs-was-not-there to the caller.

## Error codes

Added to `OperationsErrorCode` in `types.ts`:

```
'INVALID_ARGUMENT' | 'NOT_FOUND' | 'NOTE_EXISTS'
| 'CLI_NOT_FOUND' | 'CLI_UNAVAILABLE' | 'CLI_TIMEOUT' | 'CLI_ERROR'
| 'PROPERTY_NOT_FOUND'   // new
| 'TAG_NOT_FOUND'        // new
| 'UNSUPPORTED_VALUE_TYPE' // new
```

Naming note: the source task spec uses `INVALID_PARAMS` and `FILE_NOT_FOUND`. We **deliberately deviate** to keep consistency with Batch 1 (`INVALID_ARGUMENT`, `NOT_FOUND`). Functionally equivalent; saves a breaking change in published error codes.

## Configuration

Unchanged. The 6 new tools are gated by the existing `--operations` flag. No new env vars, no new CLI flags.

## Testing

### `obsidian-cli-provider.test.ts` (extension)

Mock the injected `exec`:

- `setProperty` builds correct args (text / number / checkbox / list / date / datetime); `value=a,b,c` for list; vault token still appended when `vaultName` set.
- `readProperty` parses each value type; `PROPERTY_NOT_FOUND` on stderr/empty-stdout pattern; `NOT_FOUND` when file missing.
- `removeProperty` succeeds on exit 0; succeeds on stderr `not found` (idempotent); `NOT_FOUND` on file missing.
- `listProperties` / `listTags` — `JSON.parse` of CLI output; sort already comes from CLI; empty array returned when CLI emits `[]`; `CLI_ERROR` on garbled JSON.
- `getTag` — verbose output → `{name, count, files}`; total → `{name, count}`; `TAG_NOT_FOUND` on stderr / 0-count.
- Args sanity: `sort=count`, `format=json`, `counts` always present in list commands.

### `tool-handlers.test.ts` (extension)

Mock `VaultProvider`:

- Type inference table — string/number/boolean/array/explicit-override.
- `date`/`datetime` without explicit `type` and value is a string → goes to CLI as `text` (no auto-detect).
- Array element containing a `,` → `INVALID_ARGUMENT`.
- `null` / object value → `UNSUPPORTED_VALUE_TYPE` (zod blocks most, handler asserts on the rest).
- `file` + `path` both / neither → `INVALID_ARGUMENT`.
- `path` traversal (`../etc/passwd`) → `INVALID_ARGUMENT` via `normalizePath`.
- `get_tag`: `'#mcp'` and `'mcp'` produce identical provider call; `include_files` defaults true.
- `remove_property` returns `{ ok: true }` even when provider reports the property was missing (idempotent contract).

### `tools.test.ts` (extension)

- `buildOperationsTools(...)` returns 11 registrations with expected names.
- Descriptions contain key behavioral phrases (`"sorted by occurrence count desc"`, `"Idempotent"`, `"`type`is inferred"`).

### `server-modules.test.ts` (extension)

- Both modules on → `tools/list` returns 4 semantic + 11 operations = **15 tools**.
- `--no-operations` → 4 tools.
- `--no-semantic` → 11 tools.

### Manual smoke test (pre-publish)

Run on a real vault via MCP inspector / Claude Code:

- `set_property` for text / number / boolean / list / date / datetime values.
- `read_property` round-trip for each type.
- `remove_property` for an existing property and a missing one (both succeed).
- `list_properties` and `list_tags` over the real vault.
- `get_tag` with `include_files: true` and `false`.

This is the verification step that resolves the unknowns in `property:read` and `tag verbose` output formats. If the actual CLI behavior diverges from the parsing contract above, fix the provider, update tests, and amend the relevant section of this spec inline before commit.

## README updates

- Tools matrix: 6 new rows.
- Vault Operations section: add a "Properties & Tags" subsection with one example per tool.
- Configuration table: unchanged.

## Definition of Done

- 11 operations tools (5 + 6) work through `neuro-vault` MCP.
- All unit + integration tests pass; `npm test`, `npm run lint`, `npx tsc --noEmit` all clean.
- Manual smoke test passed on a real vault.
- README updated.
- Version bumped via `npm run release` (minor → 1.6.0) and published to npm.
- The Obsidian master task and the source task note are marked done by the user (not by the agent).
