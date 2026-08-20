import { z } from 'zod';

import { runFanOut, type IFanOutResult } from './fan-out.js';
import { resolveVault } from './resolve-vault.js';
import type { ToolName } from './tool-names.js';
import type { ITool } from './tool-registry.js';
import { describeMultiVault, FAN_OUT_SUFFIX, vaultParamShape } from './vault-param.js';
import type { IVaultEntry, IVaultRegistry } from './vault-registry.js';

/**
 * Single-vault shape for a payload that has no vault identity of its own —
 * `list_tags`, `list_properties`, `get_vault_overview`.
 */
export function withVaultName<T extends Record<string, unknown>>(
  entry: IVaultEntry,
  payload: T,
): { vault: string } & T {
  return { vault: entry.name, ...payload };
}

/**
 * Single-vault shape for a payload whose result items each already carry their
 * own `vault` — `query_notes`, `search_notes`. Adding a top-level `vault` here
 * would state the same fact twice at two different granularities.
 */
export function payloadOnly<T extends Record<string, unknown>>(_entry: IVaultEntry, payload: T): T {
  return payload;
}

export interface IMultiVaultToolSpec<
  TInput extends { vault?: string },
  TPayload extends Record<string, unknown>,
  TSingle,
> {
  name: ToolName;
  title: string;
  /** Domain prose only. The multi-vault contract is appended by the builder. */
  description: string;
  /** Optional domain sentence appended after the shared fan-out suffix. */
  multiVaultNote?: string;
  /** Domain params. `vault` is contributed by the builder, never here. */
  inputShape: z.ZodRawShape;
  runForEntry: (entry: IVaultEntry, input: TInput) => Promise<TPayload>;
  /** `withVaultName` or `payloadOnly` — required, so the choice is explicit. */
  single: (entry: IVaultEntry, payload: TPayload) => TSingle;
}

/**
 * The one owner of the multi-vault dispatch contract.
 *
 * Five tools previously carried private copies of three things: this branch,
 * the fan-out description prose, and the `& Record<string, unknown>` bound
 * needed to satisfy `IFanOutResult`. The prose copies had already drifted into
 * three variants, two of them describing `skipped_vaults` semantics no code
 * path delivers. Under ADR-0010 a tool description is a delivery channel, so
 * that drift was a behaviour bug, not cosmetic debt.
 */
export function buildMultiVaultTool<
  TInput extends { vault?: string },
  TPayload extends Record<string, unknown>,
  TSingle,
>(
  registry: IVaultRegistry,
  spec: IMultiVaultToolSpec<TInput, TPayload, TSingle>,
): ITool<TInput, TSingle | IFanOutResult<TPayload>> {
  const suffix =
    spec.multiVaultNote === undefined ? FAN_OUT_SUFFIX : `${FAN_OUT_SUFFIX} ${spec.multiVaultNote}`;
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description + describeMultiVault(registry, suffix),
    inputSchema: z.object({ ...vaultParamShape(registry), ...spec.inputShape }),
    handler: async (input) => {
      if (input.vault === undefined && registry.isMulti()) {
        return await runFanOut(registry, (entry) => spec.runForEntry(entry, input));
      }
      const entry = resolveVault(input, registry, { tool: spec.name });
      return spec.single(entry, await spec.runForEntry(entry, input));
    },
  };
}
