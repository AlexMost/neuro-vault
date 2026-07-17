import { ObsidianCLIProvider, type ObsidianCLIProviderOptions } from './obsidian-cli-provider.js';
import type {
  CreateNoteInput,
  CreateNoteResult,
  DailyNoteResult,
  PropertyListEntry,
  RemovePropertyInput,
  SetPropertyInput,
  TagListEntry,
  VaultProvider,
} from '../../lib/obsidian/vault-provider.js';
import type { VaultReader } from '../../lib/obsidian/vault-reader.js';

export interface FsVaultProviderOptions extends ObsidianCLIProviderOptions {
  reader?: VaultReader;
}

/**
 * Disk-direct VaultProvider (strangler fig over ObsidianCLIProvider).
 * Methods without a disk implementation yet delegate to an internal CLI
 * provider; each migration step replaces one delegation. When none remain,
 * the delegate and ObsidianCLIProvider are deleted.
 */
export class FsVaultProvider implements VaultProvider {
  private readonly cli: ObsidianCLIProvider;
  private readonly reader: VaultReader | undefined;

  constructor(opts: FsVaultProviderOptions = {}) {
    this.cli = new ObsidianCLIProvider(opts);
    this.reader = opts.reader;
  }

  private requireReader(): VaultReader {
    if (!this.reader) throw new Error('FsVaultProvider: reader not wired');
    return this.reader;
  }

  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    return this.cli.createNote(input);
  }

  async readDaily(): Promise<DailyNoteResult> {
    return this.cli.readDaily();
  }

  async setProperty(input: SetPropertyInput): Promise<void> {
    return this.cli.setProperty(input);
  }

  async removeProperty(input: RemovePropertyInput): Promise<void> {
    return this.cli.removeProperty(input);
  }

  async listProperties(): Promise<PropertyListEntry[]> {
    return this.cli.listProperties();
  }

  async listTags(): Promise<TagListEntry[]> {
    return this.cli.listTags();
  }
}
