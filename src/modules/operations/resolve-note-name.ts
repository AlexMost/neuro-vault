import { buildBasenameIndex } from '../../lib/obsidian/link-resolver.js';
import type { VaultReader } from '../../lib/obsidian/vault-reader.js';
import { ToolHandlerError } from '../../lib/tool-response.js';
import type { OperationsErrorCode } from './types.js';

/**
 * Resolve a note name (basename, extension optional) to its unique
 * vault-relative path. Shared by every name-addressed write surface
 * (`edit_note`, `set_property`, `remove_property`) so ambiguity behaves
 * identically everywhere: zero matches → NOT_FOUND, multiple matches →
 * AMBIGUOUS_MATCH listing the candidates — never a silent first-match write.
 */
export async function resolveNoteName(reader: VaultReader, name: string): Promise<string> {
  const matches = buildBasenameIndex(await reader.scan()).resolveAll(name);
  if (matches.length === 0) {
    throw new ToolHandlerError(
      'NOT_FOUND' satisfies OperationsErrorCode,
      `Note not found for name: ${name}`,
      { details: { name } },
    );
  }
  if (matches.length > 1) {
    throw new ToolHandlerError(
      'AMBIGUOUS_MATCH' satisfies OperationsErrorCode,
      `Multiple notes match name '${name}': ${matches.join(', ')}; pass an explicit path`,
      { details: { name, matches } },
    );
  }
  return matches[0]!;
}
