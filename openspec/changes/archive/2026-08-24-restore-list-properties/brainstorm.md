<!--
Raw capture of the design conversation for this change.
NOTE: the superpowers:brainstorming skill was unavailable in this session;
per user opt-in this is a manual capture of the decision log from the live
conversation (user + Claude + downstream-consumer feedback from "Darwin",
the agent maintaining a dependent project's vault-health tooling).
-->

# Brainstorm — restore `list_properties`

## Background

v11.0.0 removed three underused MCP tools: `read_property`, `list_properties`,
`get_stats` (commit 907b70d), pointing callers at `read_notes`
(`content: 'frontmatter'`) and `get_vault_overview` as replacements.
`provider.listProperties()` was deliberately kept because `get_vault_overview`
depends on it — only the MCP tool surface was dropped.

During the 10.1.0 → 12.0.0 migration review, a downstream consumer (Darwin,
running a vault-health pipeline) audited their actual usage of the three
removed tools:

- `read_property` — dropping it; migrating to `read_notes` (frontmatter mode). ✅
- `get_stats` — dropping it; `total_notes` from `get_vault_overview` suffices. ✅
- `list_properties` — **blocked**. Their vault-health property-consistency
  sweep needs the FULL list of frontmatter properties with counts. The
  suggested replacement (`get_vault_overview`) truncates to top-N
  (`props.slice(0, TOP_PROPERTIES_LIMIT)`, limit = 30), which silently drops
  exactly the entries the sweep is looking for: rare, one-off, and misspelled
  keys.

## Key insight

The `get_vault_overview` replacement is fit for *orientation* (what does this
vault look like?) but not for *audit* (what is EVERY property in use?). The
v11 removal conflated the two use cases. The capability itself never left the
codebase — `provider.listProperties()` returns the complete inventory; the
truncation happens only in the overview presentation layer.

## Options considered (proposed by Darwin, decision left to us)

1. **Restore the `list_properties` tool** — near-verbatim revert of the v10
   tool wrapper over the still-living provider method.
2. **Add a flag to `get_vault_overview`** (e.g. `full_properties: true`) that
   lifts the truncation.
3. **Raise `TOP_PROPERTIES_LIMIT`** to some larger N.

## Decision: option 1 — restore the tool

- Option 3 is a band-aid: any fixed N still silently truncates, and "silently
  drops rare keys" is precisely the reported defect. Rejected.
- Option 2 muddies `get_vault_overview`'s contract (a single orientation
  snapshot) and its multi-vault fan-out payload shape; it also adds a
  parameter for what is really a distinct capability. Per the MCP parameter
  dictionary discipline (ADR-0005), a dedicated tool with a stable name is the
  cleaner contract. Rejected.
- Option 1 is additive (minor version, no breaking change), the implementation
  is a near-verbatim revert (the provider method never left), the tool shape
  mirrors its sibling `list_tags` exactly (same fan-out semantics), and it is
  what the consumer explicitly asked for.

## Design refinements agreed during implementation

- The restored tool's description must state its differentiator explicitly:
  it returns the COMPLETE inventory, unlike `get_vault_overview`'s top-N —
  naming the consistency-audit use case so agents route correctly.
- `get_vault_overview`'s description gains the mirror note ("top entries
  only — use `list_properties` for the full inventory").
- Server instructions, README, and `docs/guide/reading-and-modifying.md` are
  updated in the same change (verify rule: tool-surface changes must update
  the user-facing reference).
- Registration order: `list_properties` sits right after `list_tags`
  (they are siblings in shape and intent).
- Tests: registration arrays/counts updated (10 → 11 operations tools,
  13 → 14 combined); a description test pins the "full inventory vs truncated
  overview" promise. Amusing side effect: the pre-existing test title
  "registers eleven operations tools" was stale (listed 10) and becomes true
  again with this change.

## Out of scope

- `read_property` and `get_stats` stay removed — the consumer confirmed both
  replacements are acceptable.
- No change to `TOP_PROPERTIES_LIMIT` or the overview payload shape.
