/**
 * Canonical list of every tool name the server exposes.
 *
 * Used by `resolveVault` and other cross-cutting helpers to refer to a tool by
 * name without depending on the tool's module. New tools must add their name
 * here and to the constructed registry in `<module>/tools/index.ts`.
 */
export const TOOL_NAMES = [
  // Operations module
  'read_notes',
  'query_notes',
  'create_note',
  'edit_note',
  'read_daily',
  'set_property',
  'read_property',
  'remove_property',
  'list_properties',
  'list_tags',
  'get_note_links',
  'get_vault_overview',
  // Semantic module
  'search_notes',
  'get_similar_notes',
  'find_duplicates',
  'get_stats',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
