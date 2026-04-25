import type {
  AppendDailyInput,
  CreateNoteInput,
  CreateNoteResult,
  DailyNoteResult,
  EditNoteInput,
  NoteIdentifier,
  ReadNoteInput,
  ReadNoteResult,
  VaultProvider,
} from './vault-provider.js';

export type ExecFn = (
  binary: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface ObsidianCLIProviderOptions {
  binaryPath?: string;
  vaultName?: string;
  timeoutMs?: number;
  exec?: ExecFn;
}

const DEFAULT_BINARY = 'obsidian';
const DEFAULT_TIMEOUT_MS = 10_000;
const SEPARATOR = '\n---\n';

function identifierToArg(id: NoteIdentifier): string {
  return id.kind === 'name' ? `file=${id.value}` : `path=${id.value}`;
}

export class ObsidianCLIProvider implements VaultProvider {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly vaultName: string | undefined;
  private readonly exec: ExecFn;

  constructor(opts: ObsidianCLIProviderOptions = {}) {
    this.binary = opts.binaryPath ?? DEFAULT_BINARY;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.vaultName = opts.vaultName;
    if (opts.exec === undefined) {
      throw new Error('ObsidianCLIProvider: exec must be injected (real wiring lands later)');
    }
    this.exec = opts.exec;
  }

  async readNote(input: ReadNoteInput): Promise<ReadNoteResult> {
    const args = this.buildArgs('read', identifierToArg(input.identifier));
    const { stdout } = await this.exec(this.binary, args, { timeout: this.timeoutMs });
    return this.parseReadOutput(stdout);
  }

  async createNote(_input: CreateNoteInput): Promise<CreateNoteResult> {
    throw new Error('not implemented');
  }
  async editNote(_input: EditNoteInput): Promise<void> {
    throw new Error('not implemented');
  }
  async readDaily(): Promise<DailyNoteResult> {
    throw new Error('not implemented');
  }
  async appendDaily(_input: AppendDailyInput): Promise<void> {
    throw new Error('not implemented');
  }

  private buildArgs(command: string, ...kvPairs: string[]): string[] {
    const args = [command, ...kvPairs];
    if (this.vaultName) args.push(`vault=${this.vaultName}`);
    return args;
  }

  private parseReadOutput(stdout: string): ReadNoteResult {
    const sepIndex = stdout.indexOf(SEPARATOR);
    if (sepIndex === -1) {
      return { path: '', content: stdout };
    }
    return {
      path: stdout.slice(0, sepIndex),
      content: stdout.slice(sepIndex + SEPARATOR.length),
    };
  }
}
