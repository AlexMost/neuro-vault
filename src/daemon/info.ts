import fs from 'node:fs';
import writeFileAtomic from 'write-file-atomic';

export interface DaemonInfo {
  pid: number;
  version: string;
  socket: string;
  started_at: string;
  /** Size of the CLI script the daemon was keyed by (see `CliBuild` in paths.ts). */
  cli_size: number;
  /** mtime of the CLI script the daemon was keyed by, in epoch milliseconds. */
  cli_mtime_ms: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function parseDaemonInfo(raw: string): DaemonInfo | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  if (
    !isFiniteNumber(o.pid) ||
    !Number.isInteger(o.pid) ||
    o.pid <= 0 ||
    typeof o.version !== 'string' ||
    typeof o.socket !== 'string' ||
    typeof o.started_at !== 'string' ||
    !isFiniteNumber(o.cli_size) ||
    !isFiniteNumber(o.cli_mtime_ms)
  ) {
    return undefined;
  }
  return {
    pid: o.pid,
    version: o.version,
    socket: o.socket,
    started_at: o.started_at,
    cli_size: o.cli_size,
    cli_mtime_ms: o.cli_mtime_ms,
  };
}

export function readDaemonInfo(
  file: string,
  deps: { readFile?: (p: string) => string | undefined } = {},
): DaemonInfo | undefined {
  const readFile =
    deps.readFile ??
    ((p: string) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return undefined;
      }
    });
  const raw = readFile(file);
  return raw === undefined ? undefined : parseDaemonInfo(raw);
}

/** Atomic (temp + rename): a reader never sees a half-written file. */
export async function writeDaemonInfo(
  file: string,
  info: DaemonInfo,
  deps: { writeFile?: (p: string, data: string) => Promise<void> } = {},
): Promise<void> {
  const writeFile = deps.writeFile ?? ((p: string, data: string) => writeFileAtomic(p, data));
  await writeFile(file, JSON.stringify(info, null, 2) + '\n');
}
