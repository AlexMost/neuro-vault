import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const grep = promisify(execFile);

// grep exits with code 1 when nothing matches — that non-match is the PASS
// condition for each of these "must be absent from src/" invariants.
async function assertAbsentInSrc(pattern: string): Promise<void> {
  await expect(grep('grep', ['-rE', pattern, 'src/'])).rejects.toMatchObject({ code: 1 });
}

describe('Obsidian CLI removal invariants (src/)', () => {
  it('no CLI_* error codes remain', async () => {
    await assertAbsentInSrc('CLI_');
  });

  it('no ObsidianCLIProvider reference remains', async () => {
    await assertAbsentInSrc('ObsidianCLIProvider');
  });

  it('no obsidian-cli-provider module remains', async () => {
    await assertAbsentInSrc('obsidian-cli-provider');
  });

  it('no --obsidian-cli option remains', async () => {
    await assertAbsentInSrc("obsidian-cli'|obsidianCli");
  });
});
