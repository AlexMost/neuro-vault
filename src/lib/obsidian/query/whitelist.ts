import { ToolHandlerError } from '../../../lib/tool-response.js';

export const ALLOWED_OPERATORS: ReadonlySet<string> = new Set([
  '$eq',
  '$ne',
  '$in',
  '$nin',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$exists',
  '$regex',
  '$and',
  '$or',
  '$nor',
  '$not',
]);

export function validateFilter(filter: unknown): void {
  if (!isPlainObject(filter)) {
    throw invalidFilter('filter must be a JSON object');
  }
  walk(filter, []);
}

function walk(value: unknown, pathSegments: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, idx) => walk(entry, [...pathSegments, `[${idx}]`]));
    return;
  }
  if (!isPlainObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('$') && !ALLOWED_OPERATORS.has(key)) {
      const where = pathSegments.length === 0 ? key : `${pathSegments.join('.')}.${key}`;
      throw invalidFilter(`operator ${key} is not allowed (at ${where})`);
    }
    walk(child, [...pathSegments, key]);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidFilter(message: string): ToolHandlerError {
  return new ToolHandlerError('INVALID_FILTER', message);
}
