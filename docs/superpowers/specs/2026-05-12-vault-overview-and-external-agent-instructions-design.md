# Vault overview tool + vault-driven MCP instructions

Date: 2026-05-12
Status: Approved
Source task: `Tasks/Expose vault structure conventions via MCP` (vault)

## Goal

Дати зовнішньому агенту (підключеному до neuro-vault MCP з робочого проєкту, де `AGENTS.md` вокту не видно) два шари знання про вокт у момент `initialize`:

1. **Snapshot стану** — доступний двома шляхами над одним і тим же compute-кодом: (а) tool `get_vault_overview`, який агент кличе явно; (б) MCP resource `vault://overview`, який клієнти, що auto-load'ять resources, забирають у контекст без виклику. Snapshot повертає top-level папки з counts, топ-теги, frontmatter properties (name + count), total notes, топ-10 нот за backlinks. Закриває ~70% орієнтації і знімає потребу в ритуалі `list_tags + list_properties + query_notes` на старті сесії.
2. **Vault-specific конвенції** — те, що не виводиться зі snapshot (закриті набори значень `type`, заборонені папки, semantic intent). Живе у вокті, не в коді сервера, інжектиться в MCP `instructions` при `initialize`.

## Non-goals

- Recent activity per folder (mtime); YAGNI до першого болю.
- Hard `create_note` guard-rails (refuse у `Notes/`, `Resources/`, …) — окрема задача, явно винесена в source task.
- Inline-теги в body для top_tags — overview це orientation, не exhaustive count. Frontmatter-тегів достатньо.

## Architecture

### Components

```
get_vault_overview tool          vault://overview resource
(operations/tools/...)           (operations/resources/...)
            \                       /
             \                     /
              ▼                   ▼
        computeVaultOverview (lib/obsidian/vault-overview.ts)
              │
              ├──► VaultReader.scan                                       (path enumeration)
              ├──► VaultProvider.listTags + listProperties                (CLI-sourced counts)
              └──► WikilinkGraphIndex.ensureFresh + getBacklinkCount      (existing primitive)

buildServerInstructions(vaultPath) (server.ts)
    │
    ├──► static base text (current SERVER_INSTRUCTIONS, unchanged)
    ├──► always-on: one-line hint про get_vault_overview / vault://overview
    └──► optional: <vaultPath>/.neuro-vault/for-external-agents.md
              ├─ missing / unreadable → skip silently
              └─ present              → append under "## Vault-specific conventions"
```

### Module placement

- `src/modules/operations/tools/get-vault-overview.ts` — tool registration (zod schema, description, handler).
- `src/modules/operations/resources/vault-overview.ts` — resource registration (`vault://overview`, metadata, readCallback).
- `src/lib/obsidian/vault-overview.ts` — pure computation: `(reader, graph) → VaultOverview`. Testable in isolation; consumed by both the tool and the resource.
- `src/lib/resource-registration.ts` + `src/lib/resource-registry.ts` — mirrors the existing `tool-registration` / `tool-registry` pair. `ResourceRegistration = { name, uri, metadata, handler }`. Minimal scaffolding for one resource now, but matches the established module pattern so a second resource is a one-liner.
- `src/modules/operations/index.ts` — `OperationsModule` shape extends from `{ tools }` to `{ tools, resources }`. The `resources` array is always present (may be empty for other modules); the architecture doc gets updated to reflect the new contract.
- `src/server.ts` — `buildServerInstructions(vaultPath: string): Promise<string>`. `serverFactory` signature changes to accept the built string. The server-level loop registers both tools and resources from each module.

Caching: no overview-level cache. `WikilinkGraphIndex` already has a 3-minute TTL; the only remaining work per call is a single frontmatter scan (~tens of ms on a typical vault). YAGNI until measured.

## Interfaces

### Tool: `get_vault_overview`

**Input**: `{}` (empty object — overview is parameterless by design).

**Output** (`VaultOverview`):

```ts
interface VaultOverview {
  total_notes: number;
  folders: Array<{ path: string; count: number }>; // top-level only, sort by count desc
  top_tags: Array<{ name: string; count: number }>; // top 30, sort by count desc; sourced from provider.listTags()
  properties: Array<{
    name: string;
    count: number;
  }>; // top 30, sort by count desc; sourced from provider.listProperties()
  top_by_backlinks: Array<{
    path: string;
    title: string; // basename without .md
    backlink_count: number;
  }>; // top 10, sort by backlink_count desc
}
```

**Description (for MCP clients)** — surfaces "call me first":

> Returns a single snapshot of vault structure: top-level folders with note counts, top tags, frontmatter properties, total note count, and the top 10 notes by inbound wikilinks. Call this once at the start of a session to orient yourself before reaching for `list_tags`, `list_properties`, or exploratory `query_notes`.

### Resource: `vault://overview`

Same `VaultOverview` payload as the tool, served as an MCP resource for clients that auto-load resources into context (some IDEs) or let users browse them manually. Both paths share `computeVaultOverview`.

**URI**: `vault://overview` (static — no template, no params).

**Registration** (`McpServer.registerResource`):

| Field         | Value                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `name`        | `vault-overview`                                                                                              |
| `uri`         | `vault://overview`                                                                                            |
| `title`       | `Vault Overview`                                                                                              |
| `description` | Same one-paragraph blurb as the tool, with a note that the resource is the same data as `get_vault_overview`. |
| `mimeType`    | `application/json`                                                                                            |

**`readCallback`**: returns

```ts
{
  contents: [
    {
      uri: 'vault://overview',
      mimeType: 'application/json',
      text: JSON.stringify(await computeVaultOverview(...)),
    },
  ],
}
```

Errors from `computeVaultOverview` propagate; the SDK turns them into a `ReadResource` error response with the original message.

**Constants**:

- `TOP_TAGS_LIMIT = 30`
- `TOP_PROPERTIES_LIMIT = 30`
- `TOP_BACKLINKS_LIMIT = 10`

These are hard-coded in v1 (no input params). If a future caller needs more, we add an optional `limits` field then; YAGNI now.

### Folder aggregation

Top-level only. For each note path `Foo/Bar/Baz.md`, the folder is `Foo`. For a root note `Baz.md`, the folder is `"/"` (sentinel for root). Sorted by count desc, then by path asc.

### Server instructions

`buildServerInstructions(vaultPath: string): Promise<string>` lives in `src/server.ts`:

```ts
async function buildServerInstructions(vaultPath: string): Promise<string> {
  let result = STATIC_SERVER_INSTRUCTIONS; // unchanged current text
  result += '\n\n' + GET_VAULT_OVERVIEW_HINT; // always-on
  const extra = await readExternalAgentInstructions(vaultPath);
  if (extra !== null) {
    result += '\n\n## Vault-specific conventions\n\n' + extra;
  }
  return result;
}
```

Where:

- `GET_VAULT_OVERVIEW_HINT` is one paragraph telling the agent to call `get_vault_overview` once at session start.
- `readExternalAgentInstructions(vaultPath)` reads `<vaultPath>/.neuro-vault/for-external-agents.md`:
  - file missing or unreadable → returns `null` silently. The file is opt-in by convention; there is no explicit "set" mechanism, so any read failure is treated the same as absence — no stderr noise for users who do not know the feature exists.
  - file present → returns its UTF-8 content trimmed.

`serverFactory` signature changes from `() => ToolServer` to `(instructions: string) => ToolServer`. `startNeuroVaultServer` builds the string once and passes it in:

```ts
const instructions = await buildServerInstructions(config.vaultPath);
const server = serverFactory(instructions);
```

## Error handling

| Surface                                                     | Behaviour                                                                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `reader.scan()` fails                                       | Bubble as-is; tool handler returns `ToolHandlerError` (matches `query_notes`).                                          |
| Individual note read fails                                  | Skip that note in aggregation; do **not** fail the whole overview.                                                      |
| `graph.ensureFresh()` fails                                 | Bubble. Graph is already best-effort per note internally.                                                               |
| Empty vault (0 notes)                                       | Return `{ total_notes: 0, folders: [], top_tags: [], properties: [], top_by_backlinks: [] }`.                           |
| `.neuro-vault/for-external-agents.md` missing or unreadable | Silent skip; static + always-on hint only. (Opt-in convention — no warning for users who have not enabled the feature.) |

No `ToolHandlerError` codes added; existing `INVALID_ARGUMENT`/`READ_FAILED` are not raised by this tool because there is no user input.

## Testing strategy

### `vault-overview.test.ts` (unit, in-memory reader/graph)

- Empty vault → empty arrays, total_notes 0.
- Single note at root → folder `"/"` count 1.
- Multiple folders, asserts sort order + top-level-only.
- `top_tags` comes from `provider.listTags()`, passed through and sliced at `TOP_TAGS_LIMIT`.
- `properties` comes from `provider.listProperties()`, passed through and sliced at `TOP_PROPERTIES_LIMIT`.
- Top-10 backlinks: more than 10 candidates, ties broken by path asc.
- No `type` field on `top_by_backlinks` entries.

### `get-vault-overview.test.ts` (tool-level)

- Smoke test: builds tool with mocked deps, asserts schema validation accepts `{}`, output shape matches `VaultOverview`.
- Verifies tool name, title, description constants.

### `vault-overview-resource.test.ts` (resource-level)

- Smoke test: resource registration shape — name, uri (`vault://overview`), mimeType (`application/json`).
- `readCallback` returns a `contents` array of length 1 whose `text` parses back to the same `VaultOverview` returned by the underlying `computeVaultOverview` call (asserts tool and resource share the same data).

### `build-server-instructions.test.ts`

- File absent → result equals base + hint, no warning emitted.
- File present → result includes `## Vault-specific conventions` followed by file content.
- **File present but empty (or whitespace-only) → no `## Vault-specific conventions` section.** Suppressing the empty section keeps the instructions clean; the always-on hint still appears unconditionally.
- Path unreadable (e.g. is a directory) → fallback path; returns `null` silently.

### Existing tests

`server.test.ts` (if it covers `defaultServerFactory`) updated for new `instructions` parameter.

## Documentation updates

- `README.md` — add `get_vault_overview` to the tool list with a one-line description; brief note on `.neuro-vault/for-external-agents.md`.
- `docs/architecture/mcp-server-shape.md` — extend the "server instructions" paragraph to describe the dynamic layer.
- `docs/guide/vault-operations.md` — short subsection on `get_vault_overview` (next to `list_tags` / `list_properties`).

## Definition of Done

1. `get_vault_overview` registered in operations module, callable via MCP, returns shape above.
2. `vault://overview` resource registered, served by the same `computeVaultOverview` code path, returns identical payload to the tool.
3. Tool and resource require `provider.listTags()` / `provider.listProperties()` (Obsidian CLI must be running at call time). The old "does not need Obsidian to be running" claim is removed from tool description, guide, and README.
4. `buildServerInstructions` reads `.neuro-vault/for-external-agents.md` when present, falls back gracefully when absent or unreadable.
5. `get_vault_overview` / `vault://overview` are mentioned in the always-on hint regardless of whether the file exists.
6. `npm test`, `npm run lint`, `npx tsc --noEmit` все зелене.
7. README + architecture doc + vault-operations guide оновлено в тому ж PR. `module-structure.md` reflects the new `{ tools, resources }` module contract.

## Open questions

None at spec-write time. If implementation surfaces a question (e.g. how to count tags when frontmatter `tags` is a string vs. array), fix the spec inline and continue.
