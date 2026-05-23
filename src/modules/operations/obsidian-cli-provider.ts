import { execFile } from 'node:child_process';
import { stat as fsStat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ToolHandlerError } from '../../lib/tool-response.js';
import { splitFrontmatter } from '../../lib/obsidian/frontmatter.js';
import type {
  CreateNoteInput,
  CreateNoteResult,
  DailyNoteResult,
  NoteIdentifier,
  PropertyListEntry,
  PropertyValue,
  ReadPropertyInput,
  ReadPropertyResult,
  RemovePropertyInput,
  SetPropertyInput,
  TagListEntry,
  VaultProvider,
} from '../../lib/obsidian/vault-provider.js';

export type ExecFn = (
  binary: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export type FsStat = (absPath: string) => Promise<unknown>;

export interface ObsidianCLIProviderOptions {
  binaryPath?: string;
  vaultName?: string;
  vaultRoot?: string;
  timeoutMs?: number;
  exec?: ExecFn;
  stat?: FsStat;
}

const DEFAULT_BINARY = 'obsidian';
const DEFAULT_TIMEOUT_MS = 10_000;

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
  private readonly vaultRoot: string | undefined;
  private readonly exec: ExecFn;
  private readonly stat: FsStat;

  constructor(opts: ObsidianCLIProviderOptions = {}) {
    this.binary = opts.binaryPath ?? DEFAULT_BINARY;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.vaultName = opts.vaultName;
    this.vaultRoot = opts.vaultRoot;
    this.exec = opts.exec ?? defaultExec;
    this.stat = opts.stat ?? ((p) => fsStat(p));
  }

  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    if (input.name === undefined && input.path === undefined) {
      throw new Error('createNote requires name or path');
    }

    const tokens: string[] = [];
    if (input.name !== undefined) tokens.push(`name=${input.name}`);
    if (input.path !== undefined) tokens.push(`path=${input.path}`);
    if (input.content !== undefined) tokens.push(`content=${input.content}`);
    if (input.overwrite) tokens.push('overwrite');

    await this.runCommand('create', tokens);

    const resultPath = input.path ?? input.name!;

    // Post-write existence check. Skipped when vaultRoot is unknown (legacy
    // tests that construct the provider without vaultRoot). In production
    // vaultRoot is always threaded from VaultRegistry, so this catches the
    // class of silent CLI failures that returned the original bug.
    if (this.vaultRoot !== undefined && input.path !== undefined) {
      const absPath = path.join(this.vaultRoot, resultPath);
      try {
        await this.stat(absPath);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'ENOENT') {
          throw new ToolHandlerError(
            'CREATE_FAILED',
            `Obsidian CLI returned success but ${resultPath} was not written to disk. ` +
              `This usually means the CLI silently rejected the request — common causes ` +
              `include a vault-name mismatch or a path under a folder the CLI cannot create. ` +
              `Check the vault name passed to --vault matches the one Obsidian shows in ` +
              `"Manage vaults".`,
            { details: { name: input.name, path: input.path, resolvedPath: resultPath }, cause: err },
          );
        }
        throw new ToolHandlerError(
          'CLI_ERROR',
          `Failed to verify ${resultPath} was created: ${(err as Error).message}`,
          { details: { resolvedPath: resultPath }, cause: err },
        );
      }
    }

    return { path: resultPath };
  }

  async readDaily(): Promise<DailyNoteResult> {
    const { stdout: pathStdout } = await this.runCommand('daily:path', []);
    const path = pathStdout.trim();
    const { stdout } = await this.runCommand('daily:read', []);
    const { frontmatter, content } = splitFrontmatter(stdout);
    return { path, frontmatter, content };
  }

  async setProperty(input: SetPropertyInput): Promise<void> {
    const tokens: string[] = [`name=${input.name}`, `value=${this.serializeValue(input.value)}`];
    if (input.type !== undefined) tokens.push(`type=${input.type}`);
    tokens.push(identifierToArg(input.identifier));
    await this.runCommand('property:set', tokens);
  }

  async readProperty(input: ReadPropertyInput): Promise<ReadPropertyResult> {
    const { stdout } = await this.runCommand('property:read', [
      `name=${input.name}`,
      identifierToArg(input.identifier),
    ]);
    return { value: this.parsePropertyValue(stdout) };
  }

  async removeProperty(input: RemovePropertyInput): Promise<void> {
    try {
      await this.runCommand('property:remove', [
        `name=${input.name}`,
        identifierToArg(input.identifier),
      ]);
    } catch (err) {
      if (err instanceof ToolHandlerError && err.code === 'PROPERTY_NOT_FOUND') {
        return;
      }
      throw err;
    }
  }

  async listProperties(): Promise<PropertyListEntry[]> {
    const { stdout } = await this.runCommand('properties', ['counts', 'sort=count', 'format=json']);
    return this.parseJsonList<PropertyListEntry>(stdout, 'properties');
  }

  async listTags(): Promise<TagListEntry[]> {
    const { stdout } = await this.runCommand('tags', ['counts', 'sort=count', 'format=json']);
    return this.parseJsonList<TagListEntry>(stdout, 'tags');
  }

  // Best-effort: a `text` property whose value happens to be "true" or "42"
  // will be coerced to boolean/number. Callers needing ground-truth types should
  // use read_notes and parse frontmatter directly.
  private parsePropertyValue(stdout: string): PropertyValue {
    const trimmed = stdout.trim();
    if (trimmed === '') return '';
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    if (trimmed.includes('\n')) {
      return trimmed
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    return trimmed;
  }

  private serializeValue(value: PropertyValue): string {
    if (Array.isArray(value)) return value.map((v) => String(v)).join(',');
    return String(value);
  }

  private parseJsonList<T>(stdout: string, command: string): T[] {
    const trimmed = stdout.trim();
    // obsidian-cli ignores `format=json` for several list commands when the
    // result set is empty or the vault is unknown, writing a plain-text
    // sentinel to STDOUT and exiting 0. Map those sentinels here rather than
    // letting JSON.parse explode with a cryptic error.
    if (trimmed === '') return [];
    if (/^Vault not found\.?$/i.test(trimmed)) {
      throw new ToolHandlerError(
        'VAULT_NOT_FOUND',
        `Obsidian does not recognize the configured vault. ` +
          `Open the vault in Obsidian (Manage vaults) so it appears in obsidian.json.`,
        { details: { vaultName: this.vaultName, command, stdout: trimmed } },
      );
    }
    // "No tags found.", "No properties found.", "No aliases found.", etc.
    if (/^No\s+\w+\s+found\.?$/i.test(trimmed)) return [];
    try {
      const parsed = JSON.parse(stdout) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('expected array');
      }
      return parsed as T[];
    } catch (err) {
      throw new ToolHandlerError(
        'CLI_ERROR',
        `Failed to parse JSON output of '${command}': ${(err as Error).message}`,
        { details: { stdout: stdout.slice(0, 500), command }, cause: err },
      );
    }
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

    if (
      (command === 'property:read' || command === 'property:remove') &&
      /property not found|not set/i.test(stderr)
    ) {
      return new ToolHandlerError(
        'PROPERTY_NOT_FOUND',
        `Property not found: ${stderr.trim() || 'unknown'}`,
        { details: { stderr, command }, cause: error },
      );
    }

    if (/vault (not found|does not exist)/i.test(stderr)) {
      return new ToolHandlerError(
        'VAULT_NOT_FOUND',
        `Obsidian does not recognize a vault named '${this.vaultName}'. ` +
          `The MCP-side alias is derived from the vault directory's basename and must ` +
          `match the display name Obsidian shows in "Manage vaults". Rename either the ` +
          `directory (and re-launch with the matching --vault path) or the vault in ` +
          `Obsidian so the two agree.`,
        { details: { stderr, vaultName: this.vaultName }, cause: error },
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
    // obsidian-cli requires `vault=<name>` to come BEFORE the subcommand;
    // appending it after kvPairs is silently ignored and the active vault wins.
    // See https://forum.obsidian.md/t/cli-vault-parameter-ignored-all-commands-resolve-to-the-focused-vault/112217
    if (this.vaultName) {
      return [`vault=${this.vaultName}`, command, ...kvPairs];
    }
    return [command, ...kvPairs];
  }
}
