import path from 'node:path';

import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { invalidArgument } from '../tool-helpers.js';
import { normalizeNotePath } from '../../../lib/obsidian/note-path.js';
import { resolveAndRenderTemplate } from '../../../lib/obsidian/template-renderer.js';
import type { CreateNoteToolInput } from '../types.js';
import { describeMultiVault, vaultParamShape } from '../../../lib/vault-param.js';

interface Input {
  vault?: string;
  name?: string;
  path?: string;
  content?: string;
  template?: string;
  overwrite?: boolean;
}

export interface CreateNoteDeps {
  registry: IVaultRegistry;
}

export function buildCreateNoteTool(
  deps: CreateNoteDeps,
): ITool<Input, { vault: string; path: string }> {
  const { registry } = deps;
  const inputSchema = z.object({
    ...vaultParamShape(registry),
    name: z.string().optional(),
    path: z.string().optional(),
    content: z.string().optional(),
    template: z.string().optional(),
    overwrite: z.boolean().optional(),
  });
  return {
    name: 'create_note',
    title: 'Create Note',
    description:
      'Create a new note. Provide `name` or `path` (exactly one). ' +
      'Optionally provide `content` (raw markdown) OR `template` — these are mutually exclusive. ' +
      '`template` may be a bare name resolved against the `.obsidian/templates.json` `folder` ' +
      '(e.g. `"daily"`) or a vault-relative path (e.g. `"Templates/daily.md"`); paths without an ' +
      'extension are treated as `.md`. Core Templates substitutions are applied in-process: ' +
      '`{{title}}`, `{{date}}`, `{{date:FORMAT}}`, `{{time}}`, `{{time:FORMAT}}`. ' +
      'Templater syntax (`<% ... %>`) is rejected with `TEMPLATE_UNSUPPORTED` — render Templater ' +
      'yourself and pass the result as `content` instead.' +
      describeMultiVault(
        registry,
        'Pass `vault: "<name>"` to target a specific vault when multiple are registered.',
      ) +
      ' If a note with this path/name might already exist and the user has not explicitly asked to replace it, ask the user before passing `overwrite: true` — overwrite is destructive. Default behavior fails when the note exists.',
    inputSchema,
    handler: async (input) => {
      const entry = resolveVault(input, registry, { tool: 'create_note' });
      if (input.name === undefined && input.path === undefined) {
        throw invalidArgument('Provide name or path', 'name');
      }
      if (input.name !== undefined && input.path !== undefined) {
        throw invalidArgument('Provide exactly one of name or path', 'name');
      }
      if (input.content !== undefined && input.template !== undefined) {
        throw invalidArgument(
          'content and template cannot be used together — call create_note with only one. If you want a note pre-filled from a template, omit content; if you want to write exact markdown, omit template.',
          'content',
        );
      }

      const passthrough: CreateNoteToolInput = {};
      if (input.name !== undefined) {
        if (input.name.trim() === '') throw invalidArgument('name must not be empty', 'name');
        passthrough.name = input.name.trim();
      }
      if (input.path !== undefined) {
        try {
          passthrough.path = normalizeNotePath(input.path);
        } catch (err) {
          throw invalidArgument((err as Error).message, 'path');
        }
      }
      if (input.overwrite !== undefined) passthrough.overwrite = input.overwrite;

      if (input.template !== undefined) {
        const title = deriveTitle(passthrough.path, passthrough.name);
        const rendered = await resolveAndRenderTemplate({
          vaultRoot: entry.path,
          template: input.template,
          title,
        });
        passthrough.content = rendered.rendered;
      } else if (input.content !== undefined) {
        passthrough.content = input.content;
      }

      const result = await entry.provider.createNote(passthrough);
      return { vault: entry.name, ...result };
    },
  };
}

function deriveTitle(p: string | undefined, name: string | undefined): string {
  if (name !== undefined) return name;
  if (p !== undefined) {
    const base = path.posix.basename(p);
    return base.replace(/\.md$/i, '');
  }
  return '';
}
