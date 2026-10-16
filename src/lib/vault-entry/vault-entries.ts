import { realpath as fsRealpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { CorpusReader } from '../obsidian/corpus/corpus.js';
import type { EmbedDocumentsFn } from '../obsidian/corpus/types.js';
import type { BackendStatus } from '../obsidian/semantic-backend.js';
import { loadVaultConfig } from '../obsidian/vault-config.js';
import { loadVaultScope } from '../obsidian/vault-scope-config.js';
import type { VaultScope } from '../obsidian/vault-scope.js';
import { MODEL_PROFILES } from '../model-profiles.js';
import {
  createVaultEntry,
  profileIdentity,
  type VaultEntry,
  type VaultEntryOptions,
  type VaultInfo,
} from './vault-entry.js';

export type VaultEntryErrorCode = 'NOT_ATTACHED' | 'VAULT_UNAVAILABLE' | 'UNKNOWN_PROFILE';

export class VaultEntryError extends Error {
  constructor(
    readonly code: VaultEntryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VaultEntryError';
  }
}

/** The timer seam, shaped like the daemon's own so one fake serves both. */
export interface Timers {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export interface VaultEntriesDeps {
  /** Per profile key: the document embedder (daemon: the embed service's queue). */
  embedderFor: (profileKey: string) => EmbedDocumentsFn;
  /** How long an entry or a profile nobody attaches is kept; 0 = forever. */
  idleTimeoutMs: number;
  realpath?: (p: string) => Promise<string>;
  isDirectory?: (p: string) => Promise<boolean>;
  loadScope?: (vaultRoot: string) => Promise<{ scope: VaultScope; semantic: boolean }>;
  /** Injected by tests; production uses {@link createVaultEntry}. */
  createEntry?: (opts: VaultEntryOptions) => VaultEntry;
  timers?: Timers;
  now?: () => Date;
  /** Defaults to console.error — warnings must never touch stdout. */
  warn?: (message: string) => void;
}

type Timer = ReturnType<typeof setTimeout>;

/** Who uses an entry or one of its profiles, and the idle timer running while nobody does. */
interface Clients {
  ids: Set<number>;
  timer?: Timer;
  /** Attaches past their path checks that will reuse this; a timer firing meanwhile waits. */
  holds: number;
  /** What the timer does when it fires, kept to run on release when it fired under a hold. */
  expire?: () => void;
  /** The timer fired under a hold: released with no client, it expires then. */
  expired: boolean;
}

interface EntryRecord extends Clients {
  entry: VaultEntry;
  /** When the last client left; unset while any is attached. */
  idleSince?: Date;
  /** In attach order. */
  profiles: Map<string, Clients>;
}

/** A connection's attaches still awaiting I/O, and whether it closed under them. */
interface InFlight {
  count: number;
  detached: boolean;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function samePatterns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((pattern, i) => pattern === b[i]);
}

/**
 * The registry `realpath → VaultEntry` (design D1, D7, D8): attach and status
 * per connection, and the idle policy that frees what no connection uses.
 *
 * Attach awaits only path checks and the vault's two small config files; every
 * corpus load and pass runs in the background behind the answer. Every attach
 * that joins queues a pass, so an entry reconciles on attach even with no
 * watcher. The scope and the `semantic` key are re-read on every attach, and
 * the latest attach decides.
 */
export class VaultEntries {
  private readonly records = new Map<string, EntryRecord>();
  private readonly inFlight = new Map<number, InFlight>();
  /**
   * Per realpath, an entry dropped by its idle timer whose dispose is still
   * running. Its pass may still hold the vault's reconcile lock, which a second
   * loop of this process would take as stale: an attach waits it out.
   */
  private readonly dropping = new Map<string, Promise<void>>();
  private readonly realpath: (p: string) => Promise<string>;
  private readonly isDirectory: (p: string) => Promise<boolean>;
  private readonly loadScope: (root: string) => Promise<{ scope: VaultScope; semantic: boolean }>;
  private readonly createEntry: (opts: VaultEntryOptions) => VaultEntry;
  private readonly timers: Timers;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;
  private disposing: Promise<void> | null = null;

  constructor(private readonly deps: VaultEntriesDeps) {
    const warn = deps.warn ?? ((message: string) => console.error(message));
    this.warn = warn;
    this.realpath = deps.realpath ?? ((p) => fsRealpath(p));
    this.isDirectory = deps.isDirectory ?? (async (p) => (await stat(p)).isDirectory());
    this.loadScope =
      deps.loadScope ??
      (async (root) => {
        // One parse of the config serves both the scope and the switch.
        const config = await loadVaultConfig(root, { warn });
        const scope = await loadVaultScope(root, { config, warn });
        return { scope, semantic: config.semantic !== false };
      });
    this.createEntry = deps.createEntry ?? createVaultEntry;
    this.timers = deps.timers ?? { setTimeout, clearTimeout };
    this.now = deps.now ?? (() => new Date());
  }

  async attach(
    connectionId: number,
    vault: string,
    profiles: readonly string[],
  ): Promise<{ vault: string; profiles: Record<string, BackendStatus> }> {
    if (this.disposing !== null) throw new Error('vault entries: disposed');
    const flight = this.inFlight.get(connectionId) ?? { count: 0, detached: false };
    flight.count += 1;
    this.inFlight.set(connectionId, flight);
    /** What this attach holds while it reads the scope, released in order: profiles, then entry. */
    let held: Clients[] = [];
    try {
      const root = await this.resolve(vault);
      for (const key of profiles) {
        if (!Object.hasOwn(MODEL_PROFILES, key)) {
          throw new VaultEntryError(
            'UNKNOWN_PROFILE',
            `unknown profile "${key}" — choose one of: ${Object.keys(MODEL_PROFILES).join(', ')}`,
          );
        }
      }
      // From here this attach counts as arrived: an idle timer firing while the
      // scope loads must not drop what it is about to reuse.
      held = this.hold(root, profiles);
      const { scope, semantic } = await this.loadScope(root);
      if (this.disposing !== null) throw new Error('vault entries: disposed');
      for (let drop = this.dropping.get(root); drop !== undefined; drop = this.dropping.get(root)) {
        await drop;
        if (this.disposing !== null) throw new Error('vault entries: disposed');
      }
      // Synchronous from here: concurrent attaches of one vault cannot both create it.
      const record = this.recordFor(root, scope, semantic);
      // A connection that closed while this attach awaited is no client: what
      // this attach created idles out as if it had left.
      const joined = !flight.detached;
      for (const key of profiles) {
        let attached = record.profiles.get(key);
        if (attached === undefined) {
          record.entry.addProfile(key);
          attached = { ids: new Set(), holds: 0, expired: false };
          record.profiles.set(key, attached);
        }
        if (joined) this.join(attached, connectionId);
        else if (attached.ids.size === 0) this.arm(attached, () => this.free(record, key));
      }
      if (joined) {
        this.join(record, connectionId);
        record.idleSince = undefined;
        // The only reconcile trigger an entry whose watcher died still has
        // (spec: reconcile-on-attach); it coalesces with a pass the attach queued.
        record.entry.requestPass();
      } else if (record.ids.size === 0) {
        this.idle(record);
      }
      return {
        vault: root,
        profiles: Object.fromEntries(profiles.map((key) => [key, record.entry.status(key)])),
      };
    } finally {
      flight.count -= 1;
      if (flight.count === 0) this.inFlight.delete(connectionId);
      for (const clients of held) this.release(clients);
    }
  }

  status(connectionId: number, vault: string, profile: string): BackendStatus {
    return this.attached(connectionId, vault, profile).status(profile);
  }

  reader(
    connectionId: number,
    vault: string,
    profile: string,
  ): { reader: CorpusReader; status: BackendStatus; dims: number } {
    const entry = this.attached(connectionId, vault, profile);
    return {
      reader: entry.reader(profile),
      status: entry.status(profile),
      dims: profileIdentity(profile).dims,
    };
  }

  detach(connectionId: number): void {
    const flight = this.inFlight.get(connectionId);
    if (flight !== undefined) flight.detached = true;
    for (const record of this.records.values()) {
      for (const [key, attached] of record.profiles) {
        if (attached.ids.delete(connectionId) && attached.ids.size === 0) {
          this.arm(attached, () => this.free(record, key));
        }
      }
      if (record.ids.delete(connectionId) && record.ids.size === 0) this.idle(record);
    }
  }

  info(): VaultInfo[] {
    return [...this.records.values()].map((record) =>
      record.entry.info(record.ids.size, record.idleSince?.toISOString()),
    );
  }

  dispose(): Promise<void> {
    this.disposing ??= (async () => {
      const records = [...this.records.values()];
      this.records.clear();
      for (const record of records) this.clearTimers(record);
      await Promise.all([
        ...records.map((record) => this.disposeEntry(record)),
        ...this.dropping.values(),
      ]);
    })();
    return this.disposing;
  }

  private async resolve(vault: string): Promise<string> {
    if (!path.isAbsolute(vault)) {
      throw new VaultEntryError('VAULT_UNAVAILABLE', `vault "${vault}" is not an absolute path`);
    }
    let root: string;
    try {
      root = await this.realpath(vault);
    } catch (err) {
      throw new VaultEntryError(
        'VAULT_UNAVAILABLE',
        `cannot resolve vault "${vault}": ${reasonOf(err)}`,
      );
    }
    let directory: boolean;
    try {
      directory = await this.isDirectory(root);
    } catch (err) {
      throw new VaultEntryError(
        'VAULT_UNAVAILABLE',
        `cannot stat vault "${root}": ${reasonOf(err)}`,
      );
    }
    if (!directory) {
      throw new VaultEntryError('VAULT_UNAVAILABLE', `vault "${root}" is not a directory`);
    }
    return root;
  }

  private recordFor(root: string, scope: VaultScope, semantic: boolean): EntryRecord {
    const existing = this.records.get(root);
    if (existing !== undefined) {
      if (!samePatterns(existing.entry.scope.ignorePatterns, scope.ignorePatterns)) {
        existing.entry.setScope(scope);
      }
      if (existing.entry.semantic !== semantic) existing.entry.setSemantic(semantic);
      return existing;
    }
    const entry = this.createEntry({
      vaultRoot: root,
      vaultName: path.basename(root),
      scope,
      semantic,
      embedderFor: this.deps.embedderFor,
      warn: this.warn,
    });
    const record: EntryRecord = {
      entry,
      ids: new Set(),
      profiles: new Map(),
      holds: 0,
      expired: false,
    };
    this.records.set(root, record);
    return record;
  }

  private hold(root: string, profiles: readonly string[]): Clients[] {
    const record = this.records.get(root);
    if (record === undefined) return [];
    const held: Clients[] = [];
    for (const key of profiles) {
      const attached = record.profiles.get(key);
      if (attached !== undefined && !held.includes(attached)) held.push(attached);
    }
    held.push(record);
    for (const clients of held) clients.holds += 1;
    return held;
  }

  /** Runs an expiry that fired under the hold, unless a client joined or everything is gone. */
  private release(clients: Clients): void {
    clients.holds -= 1;
    if (clients.holds > 0 || !clients.expired) return;
    clients.expired = false;
    if (clients.ids.size === 0 && this.disposing === null) clients.expire?.();
  }

  private join(clients: Clients, connectionId: number): void {
    clients.ids.add(connectionId);
    clients.expired = false;
    if (clients.timer !== undefined) {
      this.timers.clearTimeout(clients.timer);
      clients.timer = undefined;
    }
  }

  /** Starts the idle timer unless one runs already, one fired under a hold, or idling out is off. */
  private arm(clients: Clients, fire: () => void): void {
    if (this.deps.idleTimeoutMs === 0 || clients.timer !== undefined || clients.expired) return;
    clients.expire = fire;
    clients.timer = this.timers.setTimeout(() => {
      clients.timer = undefined;
      if (clients.holds > 0) clients.expired = true;
      else fire();
    }, this.deps.idleTimeoutMs);
    // An idle timer must never be the reason the process stays alive.
    (clients.timer as { unref?: () => void }).unref?.();
  }

  private idle(record: EntryRecord): void {
    // The first time it went idle: the one its timer counts from.
    record.idleSince ??= this.now();
    this.arm(record, () => this.drop(record));
  }

  private free(record: EntryRecord, key: string): void {
    if (this.records.get(record.entry.vaultRoot) !== record || !record.profiles.has(key)) return;
    record.profiles.delete(key);
    record.entry.removeProfile(key);
  }

  private drop(record: EntryRecord): void {
    if (this.records.get(record.entry.vaultRoot) !== record) return;
    const root = record.entry.vaultRoot;
    this.records.delete(root);
    this.clearTimers(record);
    const done: Promise<void> = this.disposeEntry(record).finally(() => {
      if (this.dropping.get(root) === done) this.dropping.delete(root);
    });
    this.dropping.set(root, done);
  }

  private clearTimers(record: EntryRecord): void {
    for (const clients of [record, ...record.profiles.values()]) {
      if (clients.timer !== undefined) this.timers.clearTimeout(clients.timer);
      clients.timer = undefined;
      clients.expired = false;
    }
  }

  private disposeEntry(record: EntryRecord): Promise<void> {
    return record.entry.dispose().catch((err: unknown) => {
      this.warn(
        `neuro-vault: vault "${record.entry.vaultRoot}" failed to dispose: ${reasonOf(err)}`,
      );
    });
  }

  private attached(connectionId: number, vault: string, profile: string): VaultEntry {
    const record = this.records.get(vault);
    if (record === undefined || !record.profiles.get(profile)?.ids.has(connectionId)) {
      throw new VaultEntryError(
        'NOT_ATTACHED',
        `vault "${vault}" with profile "${profile}" is not attached on this connection`,
      );
    }
    return record.entry;
  }
}
