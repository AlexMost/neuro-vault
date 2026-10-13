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

/**
 * Characters of content handed to the tokenizer per token of window: a bound
 * on tokenizer work for multi-megabyte notes, not a budget. Prose runs
 * 1.6–2.9 characters per token, so the token limit binds first; only text that
 * tokenises to almost nothing (long whitespace runs) can hit this bound first.
 */
export const CHARS_PER_TOKEN_WORK_BOUND = 32;

/**
 * One model input row: template prefix, then `prefix + content` encoded
 * without special tokens and cut to fit, then the template suffix. Encoding
 * prefix and content together tokenises their boundary the way the model was
 * trained; since the prefix comes first, a cut only ever removes content.
 */
export function encodeRow(input: {
  prefix: string;
  content: string;
  template: SpecialTokenTemplate;
  maxTokens: number;
  encoder: Encoder;
}): number[] {
  const { template, maxTokens, encoder } = input;
  const budget = maxTokens - template.prefix.length - template.suffix.length;
  if (budget < 1) throw new Error(`a ${maxTokens}-token window leaves no room for content`);
  const text = input.prefix + input.content.slice(0, maxTokens * CHARS_PER_TOKEN_WORK_BOUND);
  const ids = encoder.encode(text, { add_special_tokens: false }).slice(0, budget);
  return [...template.prefix, ...ids, ...template.suffix];
}

/** Pads rows to the longest with `padId` on `side`; the mask marks real tokens with 1. */
export function padBatch(
  rows: number[][],
  padId: number,
  side: 'left' | 'right',
): { ids: number[][]; mask: number[][] } {
  if (rows.length === 0) throw new Error('cannot pad an empty batch');
  const width = Math.max(...rows.map((row) => row.length));
  const ids: number[][] = [];
  const mask: number[][] = [];
  for (const row of rows) {
    const pads = new Array<number>(width - row.length).fill(padId);
    const zeros = new Array<number>(width - row.length).fill(0);
    const ones = new Array<number>(row.length).fill(1);
    ids.push(side === 'left' ? [...pads, ...row] : [...row, ...pads]);
    mask.push(side === 'left' ? [...zeros, ...ones] : [...ones, ...zeros]);
  }
  return { ids, mask };
}
