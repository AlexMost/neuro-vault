/** The tokenizer surface tokenisation needs. */
export interface Encoder {
  encode(text: string, options: { add_special_tokens: boolean }): number[];
}

/** The special-token ids a tokenizer's post-processor places before and after content. */
export interface SpecialTokenTemplate {
  prefix: number[];
  suffix: number[];
}

const SENTINEL = 'a';

function indexOfRun(haystack: number[], needle: number[]): number {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((id, j) => haystack[i + j] === id)) return i;
  }
  return -1;
}

/**
 * Reads the template off the tokenizer instead of trusting a declared token:
 * harrier-0.6b's `eos_token_id` (151645) is not what its post-processor
 * appends (151643), so only the encoding itself is authoritative (design D5).
 */
export function deriveTemplate(encoder: Encoder): SpecialTokenTemplate {
  const raw = encoder.encode(SENTINEL, { add_special_tokens: false });
  const full = encoder.encode(SENTINEL, { add_special_tokens: true });
  const at = raw.length === 0 ? -1 : indexOfRun(full, raw);
  if (at === -1) {
    throw new Error(
      `cannot derive the special-token template: [${full.join(', ')}] does not contain [${raw.join(', ')}]`,
    );
  }
  return { prefix: full.slice(0, at), suffix: full.slice(at + raw.length) };
}
