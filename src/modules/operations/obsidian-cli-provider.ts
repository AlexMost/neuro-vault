import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolHandlerError } from '../../lib/tool-response.js';
import type {
  AppendDailyInput,
  CreateNoteInput,
  CreateNoteResult,
  DailyNoteResult,
  EditNoteInput,
  NoteIdentifier,
  PropertyValue,
  ReadNoteInput,
  ReadNoteResult,
  SetPropertyInput,
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

const execFileAsync = promisify(execFile);

const defaultExec: ExecFn = async (binary, args, options) => {
  const result = (await execFileAsync(binary, args, {
    timeout: options.timeout,
    maxBuffer: 10 * 1024 * 1024,
  })) as unknown as {
    stdout: string | { toString: () => string };
    stderr: string | { toString: () => string };
  };
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : result.stdout.toString(),
    stderr: typeof result.stderr === 'string' ? result.stderr : result.stderr.toString(),
  };
};

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
    this.exec = opts.exec ?? defaultExec;
  }

  async readNote(input: ReadNoteInput): Promise<ReadNoteResult> {
    const { stdout } = await this.runCommand('read', [identifierToArg(input.identifier)]);
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

    await this.runCommand('create', tokens);

    return { path: input.path ?? input.name! };
  }

  async editNote(input: EditNoteInput): Promise<void> {
    await this.runCommand(input.position, [
      identifierToArg(input.identifier),
      `content=${input.content}`,
    ]);
  }

  async readDaily(): Promise<DailyNoteResult> {
    const { stdout } = await this.runCommand('daily:read', []);
    return this.parseReadOutput(stdout);
  }

  async appendDaily(input: AppendDailyInput): Promise<void> {
    await this.runCommand('daily:append', [`content=${input.content}`]);
  }

  async setProperty(input: SetPropertyInput): Promise<void> {
    const tokens: string[] = [`name=${input.name}`, `value=${this.serializeValue(input.value)}`];
    if (input.type !== undefined) tokens.push(`type=${input.type}`);
    tokens.push(identifierToArg(input.identifier));
    await this.runCommand('property:set', tokens);
  }

  private serializeValue(value: PropertyValue): string {
    if (Array.isArray(value)) return value.map((v) => String(v)).join(',');
    return String(value);
  }

  private async runCommand(
    command: string,
    kvPairs: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    const args = this.buildArgs(command, ...kvPairs);
    try {
      return await this.exec(this.binary, args, { timeout: this.timeoutMs });
    } catch (error) {
      throw this.mapExecError(error, command);
    }
  }

  private mapExecError(error: unknown, command: string): ToolHandlerError {
    const errObj = (error ?? {}) as {
      code?: string | number;
      killed?: boolean;
      stderr?: string;
      message?: string;
    };
    const stderr = (errObj.stderr ?? '').toString();

    if (errObj.code === 'ENOENT') {
      return new ToolHandlerError(
        'CLI_NOT_FOUND',
        `Obsidian CLI binary not found at '${this.binary}'. Install obsidian-cli and ensure Obsidian is running.`,
        { details: { binary: this.binary }, cause: error },
      );
    }

    if (errObj.code === 'ETIMEDOUT' || errObj.killed) {
      return new ToolHandlerError(
        'CLI_TIMEOUT',
        `Obsidian CLI timed out after ${this.timeoutMs}ms.`,
        { details: { timeoutMs: this.timeoutMs }, cause: error },
      );
    }

    if (/not running|URI handler/i.test(stderr)) {
      return new ToolHandlerError(
        'CLI_UNAVAILABLE',
        'Obsidian is not running. Start Obsidian and try again.',
        { details: { stderr }, cause: error },
      );
    }

    if (command === 'create' && /already exists/i.test(stderr)) {
      return new ToolHandlerError(
        'NOTE_EXISTS',
        'Note already exists. Pass overwrite: true after confirming with the user.',
        { details: { stderr }, cause: error },
      );
    }

    if (/not found/i.test(stderr)) {
      return new ToolHandlerError('NOT_FOUND', `Note not found: ${stderr.trim() || 'unknown'}`, {
        details: { stderr, command },
        cause: error,
      });
    }

    return new ToolHandlerError(
      'CLI_ERROR',
      `Obsidian CLI failed: ${stderr || errObj.message || 'unknown error'}`,
      { details: { stderr, command, exitCode: errObj.code }, cause: error },
    );
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
