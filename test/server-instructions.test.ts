import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { SERVER_INSTRUCTIONS, startNeuroVaultServer } from '../src/server.js';

/**
 * Claude Code truncates the MCP `instructions` string at exactly this many
 * characters — *per server, not per vault* — and hands sub-agents none of it.
 * The string is a constant precisely so that no vault owner's file can push
 * server-authored guidance past this window; the suite asserts the constant
 * stays beneath it rather than fitting a representative fixture inside it.
 */
const CLIENT_INSTRUCTIONS_CAP = 2048;

async function makeTempVault(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'neuro-vault-instructions-'));
}

describe('SERVER_INSTRUCTIONS', () => {
  it('puts no vault conventions content into the instructions handed to the server', async () => {
    const vault = await makeTempVault();
    try {
      const dir = path.join(vault, '.neuro-vault');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'for-external-agents.md'),
        '## Vault rules\n\n- Do not write into Resources/\n',
        'utf8',
      );

      let handed = '';
      await startNeuroVaultServer(
        {
          vaults: [
            {
              name: path.basename(vault),
              path: vault,
            },
          ],
          semantic: { enabled: false, modelKey: 'bge-micro-v2', modelId: 'TaylorAI/bge-micro-v2' },
        },
        {
          serverFactory: (instructions: string) => {
            handed = instructions;
            return {
              registerTool: vi.fn() as never,
              registerResource: vi.fn() as never,
              connect: vi.fn().mockResolvedValue(undefined),
            };
          },
          transportFactory: () => ({}) as never,
          stdin: new PassThrough(),
        },
      );

      expect(handed).not.toContain('Do not write into Resources/');
      expect(handed).not.toMatch(/Vault-specific conventions/);
      expect(handed).toBe(SERVER_INSTRUCTIONS);
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });

  it('is a constant, under the client cap, with no dependence on vault configuration', () => {
    expect(typeof SERVER_INSTRUCTIONS).toBe('string');
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(CLIENT_INSTRUCTIONS_CAP);
  });

  it('points at get_vault_overview for the vault-specific conventions', () => {
    expect(SERVER_INSTRUCTIONS).toContain('get_vault_overview');
    expect(SERVER_INSTRUCTIONS).toMatch(/conventions/i);
  });

  it('names the project-scoping probe order: overview, then search, then the user', () => {
    const probeStep = SERVER_INSTRUCTIONS.match(/Find out in this order:[^\n]*/);
    expect(probeStep).not.toBeNull();
    const step = probeStep![0];
    expect(step.indexOf('get_vault_overview')).toBeGreaterThanOrEqual(0);
    expect(step.indexOf('get_vault_overview')).toBeLessThan(step.indexOf('search_notes'));
    expect(step.indexOf('search_notes')).toBeLessThan(step.indexOf('ask the user'));
  });

  it('never emits a multi-vault prose section — that contract lives on each tool description', () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/Multi-vault mode/);
  });
});
