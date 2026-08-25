import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// The harness must never silently drop out of the gates: `eval` in tsconfig
// `include` is what makes `tsc --noEmit` and type-aware eslint cover it.
describe('eval harness wiring', () => {
  it('keeps eval/ inside the TypeScript project', async () => {
    const tsconfig = JSON.parse(await readFile('tsconfig.json', 'utf8')) as {
      include: string[];
    };
    expect(tsconfig.include).toContain('eval');
  });

  it('exposes the npm eval script', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.eval).toBe('tsx eval/run.ts');
  });
});
