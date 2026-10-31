import type { ZodError, core } from 'zod';

export interface FormattedIssue {
  path: string;
  message: string;
  expected?: string;
}

type Issue = core.$ZodIssue;

/**
 * A `ZodError` as one message (`<path>: <message>; …`) and the issue list behind it, the shape
 * both validation edges report: the MCP tool gate and the daemon's method edge.
 *
 * A union zod rejects as a bare "Invalid input" is reported by its cause when that is clear: see
 * `unionCause`. That needs the issues to carry their `input`, so parse with `reportInput: true`;
 * without it every union keeps its own issue.
 */
export function formatZodError(error: ZodError): {
  message: string;
  issues: FormattedIssue[];
} {
  const issues = error.issues.flatMap((issue) => unionCause(issue, []) ?? [format(issue, [])]);
  const message = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
  return { message, issues };
}

function format(issue: Issue, prefix: readonly PropertyKey[]): FormattedIssue {
  const segments = [...prefix, ...issue.path];
  const path = segments.length > 0 ? segments.map(String).join('.') : '<root>';
  const formatted: FormattedIssue = { path, message: issue.message };
  const expected = (issue as { expected?: unknown }).expected;
  if (typeof expected === 'string') formatted.expected = expected;
  return formatted;
}

/**
 * The issues a failed union stands for, or `null` to report the union's own issue. A union
 * rejecting a plain object, with exactly one branch that got past the type check, is reported
 * by that branch's issues, at their paths: `paths.0: Unrecognized key: "content"`, not
 * `paths: Invalid input`. A union rejecting anything else is looked through only when its one
 * such branch fails solely on such unions, as an array of object items does. Every other
 * union, and every union over a non-object, keeps its own issue.
 */
function unionCause(issue: Issue, prefix: readonly PropertyKey[]): FormattedIssue[] | null {
  if (issue.code !== 'invalid_union') return null;
  const live = issue.errors.filter(
    (branch) => !branch.some((i) => i.code === 'invalid_type' && i.path.length === 0),
  );
  const branch = live.length === 1 ? live[0] : undefined;
  if (branch === undefined) return null;
  const path = [...prefix, ...issue.path];
  if (isPlainObject(issue.input)) {
    return branch.flatMap((i) => unionCause(i, path) ?? [format(i, path)]);
  }
  const causes = branch.map((i) => unionCause(i, path));
  return causes.every((c) => c !== null) ? causes.flat() : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}
