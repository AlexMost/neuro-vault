import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { packageMeta } from '../src/package-meta.js';
import { parseConfig } from '../src/config.js';
import {
  DEFAULT_MODEL_KEY,
  MODEL_KEYS,
  resolveModelProfile,
} from '../src/modules/semantic/model-profiles.js';

describe('parseConfig', () => {
  let tmpRoot: string;
  let vaultPath: string;
  let secondVaultPath: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neuro-vault-config-'));
    vaultPath = path.join(tmpRoot, 'Sandbox');
    secondVaultPath = path.join(tmpRoot, 'Other');
    await fs.mkdir(vaultPath);
    await fs.mkdir(secondVaultPath);
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('throws when no --vault is passed', async () => {
    await expect(parseConfig(['node', 'cli.js'])).rejects.toThrow(/--vault/);
  });

  it('registers a single vault with name = basename(path)', async () => {
    const parsed = await parseConfig(['node', 'cli.js', '--vault', vaultPath]);
    if (parsed.kind !== 'run') throw new Error('expected a run configuration');
    expect(parsed.config.vaults).toEqual([
      {
        name: 'Sandbox',
        path: vaultPath,
      },
    ]);
  });

  it('strips trailing slash before deriving basename', async () => {
    const parsed = await parseConfig(['node', 'cli.js', '--vault', vaultPath + '/']);
    if (parsed.kind !== 'run') throw new Error('expected a run configuration');
    expect(parsed.config.vaults[0].name).toBe('Sandbox');
  });

  it('registers multiple vaults — basenames become aliases', async () => {
    const parsed = await parseConfig([
      'node',
      'cli.js',
      '--vault',
      vaultPath,
      '--vault',
      secondVaultPath,
    ]);
    if (parsed.kind !== 'run') throw new Error('expected a run configuration');
    expect(parsed.config.vaults.map((v) => v.name)).toEqual(['Sandbox', 'Other']);
    expect(parsed.config.vaults.map((v) => v.path)).toEqual([vaultPath, secondVaultPath]);
  });

  it('rejects two vaults sharing the same basename with an actionable error', async () => {
    const a = path.join(tmpRoot, 'NestedA', 'Sandbox');
    const b = path.join(tmpRoot, 'NestedB', 'Sandbox');
    await fs.mkdir(path.dirname(a), { recursive: true });
    await fs.mkdir(path.dirname(b), { recursive: true });
    await fs.mkdir(a);
    await fs.mkdir(b);
    await expect(parseConfig(['node', 'cli.js', '--vault', a, '--vault', b])).rejects.toThrow(
      /Rename one of the directories/,
    );
  });

  it('rejects basename collision case-insensitively (Sandbox vs sandbox)', async () => {
    const a = path.join(tmpRoot, 'NestedA', 'Sandbox');
    const b = path.join(tmpRoot, 'NestedB', 'sandbox');
    await fs.mkdir(path.dirname(a), { recursive: true });
    await fs.mkdir(path.dirname(b), { recursive: true });
    await fs.mkdir(a);
    await fs.mkdir(b);
    await expect(parseConfig(['node', 'cli.js', '--vault', a, '--vault', b])).rejects.toThrow(
      /case-insensitive/,
    );
  });

  it('rejects a relative path', async () => {
    await expect(parseConfig(['node', 'cli.js', '--vault', 'rel/path'])).rejects.toThrow(
      /absolute/,
    );
  });

  it('rejects a basename that is not a valid identifier', async () => {
    const weird = path.join(tmpRoot, 'has space');
    await fs.mkdir(weird);
    await expect(parseConfig(['node', 'cli.js', '--vault', weird])).rejects.toThrow(
      /\/\^\[a-zA-Z0-9_-]\{1,64\}\$\//,
    );
  });

  it('rejects a vault path that does not exist', async () => {
    const missing = path.join(tmpRoot, 'does-not-exist');
    await expect(parseConfig(['node', 'cli.js', '--vault', missing])).rejects.toThrow(
      /does not exist/,
    );
  });

  it('rejects a vault path that is a file rather than a directory', async () => {
    const file = path.join(tmpRoot, 'a-file');
    await fs.writeFile(file, 'not a vault');
    await expect(parseConfig(['node', 'cli.js', '--vault', file])).rejects.toThrow(
      /not a directory/,
    );
  });

  it('rejects the removed --obsidian-cli flag with an unknown-option error', async () => {
    await expect(
      parseConfig([
        'node',
        'cli.js',
        '--vault',
        vaultPath,
        '--obsidian-cli',
        '/usr/local/bin/obsidian',
      ]),
    ).rejects.toThrow(/unknown.*obsidian-cli/i);
  });

  it('rejects --no-operations with an unknown-option error', async () => {
    await expect(
      parseConfig(['node', 'cli.js', '--vault', vaultPath, '--no-operations']),
    ).rejects.toThrow(/unknown.*operations/i);
  });

  it('returns semantic enabled by default', async () => {
    const parsed = await parseConfig(['node', 'cli.js', '--vault', vaultPath]);
    if (parsed.kind !== 'run') throw new Error('expected a run configuration');
    expect(parsed.config.semantic.enabled).toBe(true);
  });

  it('--version prints the bare version and needs no --vault', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const parsed = await parseConfig(['node', 'cli.js', '--version']);

      expect(parsed).toEqual({ kind: 'handled' });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(packageMeta.version);
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      errorLog.mockRestore();
    }
  });

  it('--help exits cleanly instead of falling through to the --vault error', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const parsed = await parseConfig(['node', 'cli.js', '--help']);

      expect(parsed).toEqual({ kind: 'handled' });
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toContain('--vault');
    } finally {
      log.mockRestore();
    }
  });

  it('still rejects a run invocation with no --vault', async () => {
    await expect(parseConfig(['node', 'cli.js', '--semantic'])).rejects.toThrow(/--vault/);
  });

  describe('index subcommand', () => {
    it('parses index --vault into the index variant', async () => {
      const parsed = await parseConfig(['node', 'cli.js', 'index', '--vault', vaultPath]);
      expect(parsed.kind).toBe('index');
      if (parsed.kind !== 'index') return;
      expect(parsed.options.vaults).toHaveLength(1);
      expect(parsed.options.vaults[0].path).toBe(vaultPath);
    });

    it('parses --prune, defaulting to off', async () => {
      const off = await parseConfig(['node', 'cli.js', 'index', '--vault', vaultPath]);
      const on = await parseConfig(['node', 'cli.js', 'index', '--prune', '--vault', vaultPath]);
      expect(off.kind === 'index' && off.options.prune).toBe(false);
      expect(on.kind === 'index' && on.options.prune).toBe(true);
    });

    it('the server invocation rejects --prune', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(
          parseConfig(['node', 'cli.js', '--prune', '--vault', vaultPath]),
        ).rejects.toThrow();
      } finally {
        errorLog.mockRestore();
      }
    });

    it('index rejects a relative vault path with the same error as server mode', async () => {
      await expect(parseConfig(['node', 'cli.js', 'index', '--vault', './rel'])).rejects.toThrow(
        /--vault: path must be absolute/,
      );
    });

    it('index without --vault is rejected naming the option', async () => {
      await expect(parseConfig(['node', 'cli.js', 'index'])).rejects.toThrow(/--vault is required/);
    });

    it('index rejects --no-semantic (server-only option)', async () => {
      await expect(
        parseConfig(['node', 'cli.js', 'index', '--no-semantic', '--vault', vaultPath]),
      ).rejects.toThrow();
    });

    it('index --help short-circuits to handled without vault validation', async () => {
      const parsed = await parseConfig(['node', 'cli.js', 'index', '--help']);
      expect(parsed.kind).toBe('handled');
    });

    it('a plain --vault invocation still resolves to the server variant', async () => {
      const parsed = await parseConfig(['node', 'cli.js', '--vault', vaultPath]);
      expect(parsed.kind).toBe('run');
    });
  });

  describe('--model', () => {
    it('defaults to the registry default', async () => {
      const parsed = await parseConfig(['node', 'cli.js', '--vault', vaultPath]);
      if (parsed.kind !== 'run') throw new Error('expected a run configuration');
      expect(parsed.config.semantic.model.key).toBe(DEFAULT_MODEL_KEY);
    });

    it('selects a profile by key', async () => {
      const parsed = await parseConfig([
        'node',
        'cli.js',
        '--vault',
        vaultPath,
        '--model',
        'granite-97m',
      ]);
      if (parsed.kind !== 'run') throw new Error('expected a run configuration');
      expect(parsed.config.semantic.model).toBe(resolveModelProfile('granite-97m'));
    });

    it('rejects an unknown key, listing the allowed keys', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(
          parseConfig(['node', 'cli.js', '--vault', vaultPath, '--model', 'all-MiniLM-L6-v2']),
        ).rejects.toThrow(new RegExp(MODEL_KEYS.map((k) => `"${k}"`).join('.*'), 's'));
      } finally {
        errorLog.mockRestore();
      }
    });

    it('rejects --model given twice', async () => {
      await expect(
        parseConfig([
          'node',
          'cli.js',
          '--vault',
          vaultPath,
          '--model',
          'granite-97m',
          '--model',
          'harrier-0.6b',
        ]),
      ).rejects.toThrow('--model may be given only once');
    });

    it('rejects the retired bge-micro-v2 profile, listing the current keys', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(
          parseConfig(['node', 'cli.js', '--vault', vaultPath, '--model', 'bge-micro-v2']),
        ).rejects.toThrow(/Choices:.*"harrier-270m".*"granite-97m".*"harrier-0.6b"/s);
      } finally {
        errorLog.mockRestore();
      }
    });

    it('accepts --model alongside --no-semantic', async () => {
      const parsed = await parseConfig([
        'node',
        'cli.js',
        '--vault',
        vaultPath,
        '--no-semantic',
        '--model',
        'granite-97m',
      ]);
      if (parsed.kind !== 'run') throw new Error('expected a run configuration');
      expect(parsed.config.semantic.enabled).toBe(false);
    });

    it('documents the choices and the default in --help', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await parseConfig(['node', 'cli.js', '--help']);
        const help = String(log.mock.calls[0][0]);
        expect(help).toContain('--model');
        for (const key of MODEL_KEYS) expect(help).toContain(key);
        // yargs wraps the choices/default block at the terminal width.
        expect(help.replace(/\s+/g, ' ')).toContain(`default: "${DEFAULT_MODEL_KEY}"`);
      } finally {
        log.mockRestore();
      }
    });

    it('index accepts the same keys and default', async () => {
      const parsed = await parseConfig([
        'node',
        'cli.js',
        'index',
        '--vault',
        vaultPath,
        '--model',
        'granite-97m',
      ]);
      if (parsed.kind !== 'index') throw new Error('expected index');
      expect(parsed.options.model.key).toBe('granite-97m');
      const plain = await parseConfig(['node', 'cli.js', 'index', '--vault', vaultPath]);
      if (plain.kind !== 'index') throw new Error('expected index');
      expect(plain.options.model.key).toBe(DEFAULT_MODEL_KEY);
    });

    it('index rejects an unknown key the same way', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(
          parseConfig(['node', 'cli.js', 'index', '--vault', vaultPath, '--model', 'bge-m3']),
        ).rejects.toThrow(/Choices/);
      } finally {
        errorLog.mockRestore();
      }
    });
  });
});
