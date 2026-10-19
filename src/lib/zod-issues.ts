import type { ZodError } from 'zod';

export interface FormattedIssue {
  path: string;
  message: string;
  expected?: string;
}

/**
 * A `ZodError` as one message (`<path>: <message>; …`) and the issue list behind it, the shape
 * both validation edges report: the MCP tool gate and the daemon's method edge.
 */
export function formatZodError(error: ZodError): {
  message: string;
  issues: FormattedIssue[];
} {
  const issues: FormattedIssue[] = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    const expected = (issue as unknown as { expected?: unknown }).expected;
    const formatted: FormattedIssue = { path, message: issue.message };
    if (typeof expected === 'string') formatted.expected = expected;
    return formatted;
  });
  const message = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
  return { message, issues };
}
