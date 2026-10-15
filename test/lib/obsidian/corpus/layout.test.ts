import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { hasErrnoCode } from '../../../../src/lib/obsidian/corpus/errno.js';
import {
  CORPUS_DIR,
  corpusRootOf,
  isModelDirName,
  modelCorpusDir,
} from '../../../../src/lib/obsidian/corpus/layout.js';

describe('corpus layout', () => {
  it.each(['harrier-270m', 'granite-97m', 'harrier-0.6b', 'bge-micro-v2', 'a', 'x'.repeat(64)])(
    'accepts %s as a model directory name',
    (name) => {
      expect(isModelDirName(name)).toBe(true);
    },
  );

  it.each([
    '',
    '.',
    '..',
    '.hidden',
    'a/b',
    'a\\b',
    'notes',
    'Notes',
    'manifest.json',
    'Manifest.JSON',
    'reconcile.lock',
    'RECONCILE.LOCK',
    '-x',
    'x'.repeat(65),
    'naïve',
  ])('rejects %j as a model directory name', (name) => {
    expect(isModelDirName(name)).toBe(false);
  });

  it('roots every model under the vault corpus directory', () => {
    expect(CORPUS_DIR).toBe('.neuro-vault/corpus');
    expect(corpusRootOf('/v')).toBe(path.join('/v', '.neuro-vault/corpus'));
    expect(modelCorpusDir('/v', 'granite-97m')).toBe(
      path.join('/v', '.neuro-vault/corpus', 'granite-97m'),
    );
  });

  it('refuses to build a path from an invalid key', () => {
    expect(() => modelCorpusDir('/v', '../escape')).toThrow(
      '"../escape" is not a valid model directory name',
    );
  });
});

describe('hasErrnoCode', () => {
  it('matches a system error by code only', () => {
    expect(hasErrnoCode(Object.assign(new Error('x'), { code: 'ENOENT' }), 'ENOENT')).toBe(true);
    expect(hasErrnoCode(Object.assign(new Error('x'), { code: 'EEXIST' }), 'ENOENT')).toBe(false);
    expect(hasErrnoCode(new Error('x'), 'ENOENT')).toBe(false);
    expect(hasErrnoCode('ENOENT', 'ENOENT')).toBe(false);
  });
});
