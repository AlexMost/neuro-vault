import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { packageMeta } from '../src/package-meta.js';

describe('packageMeta', () => {
  it('mirrors the package manifest', async () => {
    const manifestPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'package.json',
    );
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      name: string;
      version: string;
    };

    expect(packageMeta.name).toBe(manifest.name);
    expect(packageMeta.version).toBe(manifest.version);
    expect(packageMeta.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
