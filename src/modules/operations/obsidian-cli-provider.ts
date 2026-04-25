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

  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    if (input.name === undefined && input.path === undefined) {
      throw new Error('createNote requires name or path');
    }

    const tokens: string[] = [];
    if (input.name !== undefined) tokens.push(`name=${input.name}`);
    if (input.path !== undefined) tokens.push(`path=${input.path}`);
    if (input.content !== undefined) tokens.push(`content=${input.content}`);
    if (input.template !== undefined) tokens.push(`template=${input.template}`);
    if (input.overwrite) tokens.push('overwrite');

    const args = this.buildArgs('create', ...tokens);
    await this.exec(this.binary, args, { timeout: this.timeoutMs });

    return { path: input.path ?? input.name! };
  }
  async editNote(input: EditNoteInput): Promise<void> {
    const command = input.position;
    const args = this.buildArgs(
      command,
      identifierToArg(input.identifier),
      `content=${input.content}`,
    );
    await this.exec(this.binary, args, { timeout: this.timeoutMs });
  }
  async readDaily(): Promise<DailyNoteResult> {
    const args = this.buildArgs('daily:read');
    const { stdout } = await this.exec(this.binary, args, { timeout: this.timeoutMs });
    return this.parseReadOutput(stdout);
  }

  async appendDaily(input: AppendDailyInput): Promise<void> {
    const args = this.buildArgs('daily:append', `content=${input.content}`);
    await this.exec(this.binary, args, { timeout: this.timeoutMs });
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
