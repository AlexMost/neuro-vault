import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';

/** Vault-relative location of the owner-authored conventions file. */
export const CONVENTIONS_PATH = '.neuro-vault/for-external-agents.md';

/**
 * Soft cap on the conventions text carried in a tool response. Unlike the MCP
 * `instructions` channel there is no client-imposed limit here; the cap exists
 * so one oversized file can't inflate every session start. Trimming is always
 * surfaced via the `truncated` flag — never silent.
 */
export const CONVENTIONS_CHAR_CAP = 8000;

const TRUNCATION_MARKER = '…';

export type ConventionsReadFile = (p: string, enc: 'utf8') => Promise<string>;

/**
 * Best-effort read of a vault's conventions file. Missing, empty,
 * whitespace-only, and unreadable all collapse to `null` — the file is
 * optional and must never turn a working call into an error.
 */
export async function readVaultConventions(
  vaultPath: string,
  readFile: ConventionsReadFile = (p, enc) => fsReadFile(p, enc),
): Promise<string | null> {
  try {
    const raw = await readFile(path.join(vaultPath, CONVENTIONS_PATH), 'utf8');
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * Bounded slice plus a flag — the same shape as `previewBody`, at a much
 * larger cap. Cuts at the last whitespace inside the cap so the slice ends on
 * a word boundary rather than mid-token.
 */
export function capConventions(raw: string): { content: string; truncated: boolean } {
  if (raw.length <= CONVENTIONS_CHAR_CAP) {
    return { content: raw, truncated: false };
  }
  const segment = raw.slice(0, CONVENTIONS_CHAR_CAP + 1);
  const lastWs = Math.max(segment.lastIndexOf(' '), segment.lastIndexOf('\n'));
  const cutAt = lastWs !== -1 ? lastWs : CONVENTIONS_CHAR_CAP;
  return { content: raw.slice(0, cutAt).trimEnd() + TRUNCATION_MARKER, truncated: true };
}
