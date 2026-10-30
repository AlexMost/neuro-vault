import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * The MCP `annotations` every tool advertises. Clients use them to decide how
 * much to trust a call before it runs — a per-server "untrusted" mode that
 * confirms every tool call, say, lets a `readOnlyHint: true` tool through
 * unprompted, so reads run freely and writes still need a confirmation.
 *
 * Every tool declares one of these two through its dispatch builder
 * (`buildSingleVaultTool` / `buildMultiVaultTool`), where the field is
 * required: a tool that says nothing about itself fails `npm run typecheck`.
 * Both are closed-world — the server only ever touches the local vault.
 */

/**
 * A read: never mutates the vault and is safe to repeat. `destructiveHint` is
 * stated outright rather than left to its spec default of `true`, so a client
 * that reads it without first checking `readOnlyHint` still sees the truth.
 */
export const READ_ONLY_TOOL: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

/**
 * A write that can replace or delete what is already there: `create_note`
 * under `overwrite: true`, `edit_note` without `replace` (whole-body
 * overwrite), `set_property` on an existing key, `remove_property` always.
 * `idempotentHint` is left unset (spec default `false`): a repeated call is
 * not safe in general.
 */
export const DESTRUCTIVE_WRITE_TOOL: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
});
