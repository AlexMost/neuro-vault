const REGEX_KEY = '$regex';
const OPTIONS_KEY = '$options';
const DEFAULT_OPTIONS = 'i';

export function applyDefaultRegexOptions(filter: Record<string, unknown>): Record<string, unknown> {
  return walk(filter) as Record<string, unknown>;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(walk);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = walk(child);
  }
  if (REGEX_KEY in out && !(OPTIONS_KEY in out)) {
    out[OPTIONS_KEY] = DEFAULT_OPTIONS;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
