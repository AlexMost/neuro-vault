import fs from 'node:fs';
import path from 'node:path';

import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';

import {
  DEFAULT_MODEL_KEY,
  MODEL_KEYS,
  resolveModelProfile,
  type ModelProfile,
} from './modules/semantic/model-profiles.js';

import type { DaemonCliOptions, ServerConfig, IVaultConfig } from './types.js';
import { packageMeta } from './package-meta.js';

export const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
/** The largest idle timeout a Node timer holds: above 2^31−1 ms it fires after 1 ms. */
export const MAX_IDLE_TIMEOUT_MINUTES = Math.floor((2 ** 31 - 1) / 60_000);
const DAEMON_ACTIONS = ['status', 'stop'] as const;

const VAULT_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function basenameNoTrailingSlash(p: string): string {
  return path.basename(p.replace(/\/+$/, ''));
}

export interface IndexCliOptions {
  vaults: IVaultConfig[];
  model: ModelProfile;
}

/**
 * The ways argument parsing can end.
 *
 * `handled` means yargs itself satisfied the invocation — it printed help or
 * the version and, because of `.exitProcess(false)`, returned instead of
 * exiting. There is no config to produce and nothing left to validate.
 */
export type ParsedCli =
  | { kind: 'run'; config: ServerConfig }
  | { kind: 'index'; options: IndexCliOptions }
  | { kind: 'daemon'; options: DaemonCliOptions }
  | { kind: 'handled' };

function buildVaultConfig(rawPath: string): IVaultConfig {
  if (!path.isAbsolute(rawPath)) {
    throw new Error(`--vault: path must be absolute, got "${rawPath}"`);
  }
  const normalizedPath = path.resolve(rawPath);
  const name = basenameNoTrailingSlash(normalizedPath);
  if (!VAULT_NAME_RE.test(name)) {
    throw new Error(
      `--vault: directory basename "${name}" is not a valid vault identifier ` +
        `(allowed pattern: /^[a-zA-Z0-9_-]{1,64}$/ — ASCII letters, digits, "_", or "-"; ` +
        `1-64 chars; no spaces or Unicode). Rename the directory.`,
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(normalizedPath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new Error(`--vault: directory does not exist: "${normalizedPath}"`);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(`--vault: path is not a directory: "${normalizedPath}"`);
  }
  return {
    name,
    path: normalizedPath,
  };
}

function validateVaults(rawVaults: string[]): IVaultConfig[] {
  if (rawVaults.length === 0) {
    throw new Error('--vault is required: provide at least one vault with --vault <path>');
  }

  const vaults: IVaultConfig[] = rawVaults.map(buildVaultConfig);
  // Case-insensitive uniqueness: vault lookup is case-insensitive (so callers
  // can type "obsidian" or "Obsidian"), which means two vaults with basenames
  // that differ only in case (Sandbox vs sandbox) would alias the same lookup
  // key — rejected.
  const seen = new Set<string>();
  for (const v of vaults) {
    const key = v.name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(
        `--vault: two vaults share the directory basename "${v.name}" (case-insensitive). ` +
          `Rename one of the directories — the basename doubles as the MCP-side alias and must be unique.`,
      );
    }
    seen.add(key);
  }

  return vaults;
}

const VAULT_OPTION = {
  type: 'string',
  array: true,
  describe:
    'Absolute path to a vault directory. Repeat for multi-vault. The MCP-side alias is derived from the directory basename.',
} as const;

const MODEL_OPTION = {
  type: 'string',
  choices: MODEL_KEYS,
  default: DEFAULT_MODEL_KEY,
  describe:
    'Embedding model profile, one per process. A vault indexed with another model is rebuilt, so give the server and `index` the same value.',
} as const;

function readModel(raw: unknown): ModelProfile {
  // yargs turns a repeated flag into an array; picking one silently would hide a mistake.
  if (Array.isArray(raw)) throw new Error('--model may be given only once');
  return resolveModelProfile(String(raw));
}

const IDLE_TIMEOUT_OPTION = {
  type: 'string',
  default: DEFAULT_IDLE_TIMEOUT_MINUTES,
  describe: 'Minutes without a connected client before the daemon exits (0 = never).',
} as const;

function readIdleTimeout(raw: unknown): number {
  // yargs turns a repeated flag into an array; picking one silently would hide a mistake.
  if (Array.isArray(raw)) throw new Error('--idle-timeout may be given only once');
  // Declared as a string option on purpose: yargs' number coercion turns `''` (an empty shell
  // variable) into 0, which would silently mean "never exit on idle". Parse it strictly here.
  const text = typeof raw === 'string' ? raw.trim() : raw;
  const minutes =
    typeof text === 'number'
      ? text
      : typeof text === 'string' && /^\d+$/.test(text)
        ? Number(text)
        : NaN;
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new Error(
      `--idle-timeout: expected a non-negative integer of minutes, got "${String(raw)}"`,
    );
  }
  if (minutes > MAX_IDLE_TIMEOUT_MINUTES) {
    throw new Error(`--idle-timeout: at most ${MAX_IDLE_TIMEOUT_MINUTES} minutes; use 0 for never`);
  }
  return minutes;
}

function readDaemonAction(raw: unknown): DaemonCliOptions['action'] {
  if (raw === undefined) return undefined;
  if (raw === 'status' || raw === 'stop') return raw;
  const shown = typeof raw === 'string' ? raw : JSON.stringify(raw);
  throw new Error(
    `daemon: unknown action "${shown}" — choose one of: ${DAEMON_ACTIONS.join(', ')}`,
  );
}

export async function parseConfig(argv: string[]): Promise<ParsedCli> {
  const args = await yargs(hideBin(argv))
    .scriptName('neuro-vault-mcp')
    .usage('$0 --vault <path> [--vault <path> ...]\n\nMCP server for one or more Obsidian vaults.')
    .command('$0', 'Run the MCP server over stdio (default)', (y) =>
      y
        .option('vault', VAULT_OPTION)
        .option('semantic', {
          type: 'boolean',
          default: true,
          describe: 'Enable semantic search module (embedding-based search)',
        })
        .option('model', MODEL_OPTION),
    )
    .command('index', 'Build or refresh the embedding corpus for each vault, then exit', (y) =>
      y.option('vault', VAULT_OPTION).option('model', MODEL_OPTION),
    )
    .command(
      'daemon [action]',
      'Run the shared-services daemon; `status` lists daemons, `stop` ends them',
      (y) =>
        y
          .positional('action', {
            type: 'string',
            describe: `One of: ${DAEMON_ACTIONS.join(', ')}. Omit to run the daemon.`,
          })
          .option('idle-timeout', IDLE_TIMEOUT_OPTION),
    )
    .strict()
    .help()
    .version(packageMeta.version)
    .exitProcess(false)
    .parse();

  // yargs already satisfied this invocation by printing help or the version.
  // `.exitProcess(false)` means it did not exit for us, so stop here — running
  // the --vault guard below would print a spurious error after the help text
  // and exit non-zero.
  if (args.help === true || args.version === true) {
    return { kind: 'handled' };
  }

  if (args._[0] === 'daemon') {
    return {
      kind: 'daemon',
      options: {
        action: readDaemonAction(args.action),
        idleTimeoutMinutes: readIdleTimeout(args['idle-timeout']),
      },
    };
  }

  const vaults = validateVaults((args.vault as string[] | undefined) ?? []);

  const model = readModel(args.model);

  if (args._[0] === 'index') {
    return { kind: 'index', options: { vaults, model } };
  }
  return {
    kind: 'run',
    config: {
      vaults,
      semantic: {
        enabled: (args.semantic as boolean | undefined) ?? true,
        model,
      },
    },
  };
}
