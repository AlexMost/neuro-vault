import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { packageMeta } from '../src/package-meta.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJson<T>(...segments: string[]): Promise<T> {
  return JSON.parse(await fs.readFile(path.join(repoRoot, ...segments), 'utf8')) as T;
}

interface Engines {
  engines?: { node?: string };
}

describe('packageMeta', () => {
  it('mirrors the package manifest', async () => {
    const manifest = await readJson<{ name: string; version: string }>('package.json');

    expect(packageMeta.name).toBe(manifest.name);
    expect(packageMeta.version).toBe(manifest.version);
    expect(packageMeta.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('engines.node', () => {
  it('matches the lockfile root entry', async () => {
    const manifest = await readJson<Engines>('package.json');
    const lock = await readJson<{ packages: Record<string, Engines> }>('package-lock.json');

    expect(lock.packages['']?.engines?.node).toBe(manifest.engines?.node);
  });

  // yargs 18 declares the highest Node floor of any runtime dependency; our
  // engines field states the same range so npm warns before yargs would.
  it("states yargs' floor", async () => {
    const manifest = await readJson<Engines>('package.json');
    const yargs = await readJson<Engines>('node_modules', 'yargs', 'package.json');

    expect(manifest.engines?.node).toBe(yargs.engines?.node);
  });
});
