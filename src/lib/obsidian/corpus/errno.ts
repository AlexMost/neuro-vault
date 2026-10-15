/** Whether `err` is a Node system error carrying `code` (`ENOENT`, `EEXIST`, …). */
export function hasErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}
