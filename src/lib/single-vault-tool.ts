import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { CorpusNotReadyError, type ISemanticBackend } from './obsidian/semantic-backend.js';
import { resolveSemanticVault, resolveVault, semanticReadinessError } from './resolve-vault.js';
import type { ToolName } from './tool-names.js';
import type { ITool } from './tool-registry.js';
import { describeMultiVault, EXPLICIT_VAULT_SUFFIX, vaultParamShape } from './vault-param.js';
import type { IRegisteredVault, IVaultRegistry } from './vault-registry.js';

interface ISingleVaultSpecBase {
  name: ToolName;
  title: string;
  /** The MCP annotations the tool advertises — `src/lib/tool-annotations.ts`. */
  annotations: ToolAnnotations;
  /** Domain prose only. The explicit-vault contract is appended by the builder. */
  description: string;
  /**
   * Domain params. `vault` is contributed by the builder, never here — enforced
   * at the type level by excluding a `vault` key (`vault?: never`), so a spec
   * that declares one fails `npm run typecheck` rather than silently
   * overriding, or in single-vault mode single-handedly reintroducing, the
   * builder's own `vault` param.
   */
  inputShape: z.ZodRawShape & { vault?: never };
}

export interface ISingleVaultToolSpec<
  TInput extends { vault?: string },
  TOutput,
> extends ISingleVaultSpecBase {
  semantic?: false;
  runForEntry: (entry: IRegisteredVault, input: TInput) => Promise<TOutput>;
}

/**
 * The `semantic: true` variant resolves through `resolveSemanticVault`, which
 * owns the readiness gate (SEMANTIC_INDEX_BUILDING / SEMANTIC_DISABLED /
 * SEMANTIC_INDEX_NOT_FOUND) — so the per-vault function sees a backend that is
 * present and ready, typed as such. A `CorpusNotReadyError` the per-vault
 * function lets through is reported with the same codes.
 */
export interface ISemanticVaultToolSpec<
  TInput extends { vault?: string },
  TOutput,
> extends ISingleVaultSpecBase {
  semantic: true;
  runForEntry: (
    entry: IRegisteredVault & { backend: ISemanticBackend },
    input: TInput,
  ) => Promise<TOutput>;
}

/**
 * The one owner of the explicit-vault dispatch contract — the mirror of
 * `buildMultiVaultTool` for the nine tools that cannot fan out. Each of them
 * previously hand-rolled three pieces: the `vaultParamShape` spread, the
 * `EXPLICIT_VAULT_SUFFIX` concatenation, and a resolver call restating the
 * tool's own name literal. The suffix-goes-last invariant was enforced by
 * nothing and had already broken twice.
 */
export function buildSingleVaultTool<TInput extends { vault?: string }, TOutput>(
  registry: IVaultRegistry,
  spec: ISingleVaultToolSpec<TInput, TOutput> | ISemanticVaultToolSpec<TInput, TOutput>,
): ITool<TInput, TOutput> {
  const block = describeMultiVault(registry, EXPLICIT_VAULT_SUFFIX);
  return {
    name: spec.name,
    title: spec.title,
    annotations: spec.annotations,
    description: block === '' ? spec.description : `${spec.description}\n\n${block}`,
    inputSchema: z.object({ ...vaultParamShape(registry), ...spec.inputShape }),
    handler: async (input) => {
      if (spec.semantic !== true) {
        return spec.runForEntry(resolveVault(input, registry, { tool: spec.name }), input);
      }
      const entry = await resolveSemanticVault(input, registry, { tool: spec.name });
      try {
        return await spec.runForEntry(entry, input);
      } catch (error) {
        // The status the gate read was `ready`, but a read the corpus refused
        // since (a daemon respawned and indexing again, say) is reported the
        // way the gate reports that state.
        if (error instanceof CorpusNotReadyError) {
          throw semanticReadinessError(entry, error.status);
        }
        throw error;
      }
    },
  };
}
