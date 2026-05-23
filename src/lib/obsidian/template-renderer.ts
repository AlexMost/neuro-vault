import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';

import { ToolHandlerError } from '../tool-response.js';
import { normalizeNotePath } from './note-path.js';

export type FsReadFile = (absPath: string, encoding: 'utf8') => Promise<string>;

const TEMPLATES_CONFIG_REL = '.obsidian/templates.json';

export interface ResolvedTemplate {
  /** Vault-relative POSIX path to the template file. */
  path: string;
  /** Template content with Core Templates substitutions applied. */
  rendered: string;
}

export interface ResolveAndRenderTemplateInput {
  vaultRoot: string;
  template: string;
  title: string;
  now?: Date;
  readFile?: FsReadFile;
}

interface SubstitutionContext {
  title: string;
  now: Date;
}

/**
 * Apply Core Templates plugin substitutions: {{title}}, {{date}},
 * {{date:FORMAT}}, {{time}}, {{time:FORMAT}}. Tokens outside this set pass
 * through unchanged. Format strings support the minimal moment-compatible
 * tokens: YYYY MM DD HH mm ss (literal separators preserved).
 */
export function applyCoreTemplateSubstitutions(
  body: string,
  ctx: SubstitutionContext,
): string {
  return body.replace(/\{\{([^{}]+)\}\}/g, (match, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed === 'title') return ctx.title;
    if (trimmed === 'date') return formatDate(ctx.now, 'YYYY-MM-DD');
    if (trimmed === 'time') return formatDate(ctx.now, 'HH:mm');
    const dateFmt = /^date:(.+)$/.exec(trimmed);
    if (dateFmt) return formatDate(ctx.now, dateFmt[1]!);
    const timeFmt = /^time:(.+)$/.exec(trimmed);
    if (timeFmt) return formatDate(ctx.now, timeFmt[1]!);
    return match;
  });
}

/**
 * Resolve a template input (name or path), read it from disk, reject if it
 * contains Templater syntax (`<%`), and apply Core Templates substitutions.
 *
 * Resolution rules:
 *   - Input contains '/' OR ends in '.md' → treated as a vault-relative path
 *     and normalized via {@link normalizeNotePath} (.md auto-appended).
 *   - Otherwise → treated as a bare template name; resolved against the
 *     `folder` field of `.obsidian/templates.json` with '.md' appended.
 */
export async function resolveAndRenderTemplate(
  input: ResolveAndRenderTemplateInput,
): Promise<ResolvedTemplate> {
  const readFile = input.readFile ?? fsReadFile;
  const now = input.now ?? new Date();

  const templatePath = await resolveTemplatePath(input.vaultRoot, input.template, readFile);

  let body: string;
  try {
    body = await readFile(path.join(input.vaultRoot, templatePath), 'utf8');
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new ToolHandlerError(
        'TEMPLATE_NOT_FOUND',
        `Template not found: ${templatePath}. Check the template name or path.`,
        { details: { template: input.template, resolvedPath: templatePath }, cause: err },
      );
    }
    throw new ToolHandlerError(
      'READ_FAILED',
      `Failed to read template ${templatePath}: ${(err as Error).message}`,
      { details: { template: input.template, resolvedPath: templatePath }, cause: err },
    );
  }

  if (body.includes('<%')) {
    throw new ToolHandlerError(
      'TEMPLATE_UNSUPPORTED',
      `Template ${templatePath} contains Templater syntax (<% ... %>), which neuro-vault does not render. ` +
        `Either rewrite the template using Core Templates tokens ({{title}}, {{date}}, {{time}}), or render the ` +
        `template yourself and pass the result as create_note's 'content' parameter.`,
      { details: { template: input.template, resolvedPath: templatePath } },
    );
  }

  return {
    path: templatePath,
    rendered: applyCoreTemplateSubstitutions(body, { title: input.title, now }),
  };
}

async function resolveTemplatePath(
  vaultRoot: string,
  templateInput: string,
  readFile: FsReadFile,
): Promise<string> {
  const trimmed = templateInput.trim();
  if (trimmed === '') {
    throw new ToolHandlerError(
      'INVALID_ARGUMENT',
      `template must not be empty`,
      { details: { field: 'template' } },
    );
  }
  // Path form: contains '/' or ends in '.md'.
  if (trimmed.includes('/') || /\.md$/i.test(trimmed)) {
    return normalizeNotePath(trimmed);
  }
  // Name form: resolve against .obsidian/templates.json folder.
  const configPath = path.join(vaultRoot, TEMPLATES_CONFIG_REL);
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    throw new ToolHandlerError(
      'TEMPLATE_NOT_CONFIGURED',
      `Cannot resolve template name '${trimmed}': ${TEMPLATES_CONFIG_REL} is not present. ` +
        `Either configure Obsidian's Templates core plugin, or pass an explicit path (e.g. 'Templates/${trimmed}.md').`,
      { details: { template: trimmed, configPath: TEMPLATES_CONFIG_REL }, cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ToolHandlerError(
      'TEMPLATE_NOT_CONFIGURED',
      `Cannot resolve template name '${trimmed}': ${TEMPLATES_CONFIG_REL} is not valid JSON.`,
      { details: { template: trimmed, configPath: TEMPLATES_CONFIG_REL }, cause: err },
    );
  }
  const folder =
    parsed && typeof parsed === 'object'
      ? typeof (parsed as Record<string, unknown>).folder === 'string'
        ? ((parsed as Record<string, unknown>).folder as string).trim()
        : ''
      : '';
  if (folder === '') {
    throw new ToolHandlerError(
      'TEMPLATE_NOT_CONFIGURED',
      `Cannot resolve template name '${trimmed}': ${TEMPLATES_CONFIG_REL} has no 'folder' set.`,
      { details: { template: trimmed, configPath: TEMPLATES_CONFIG_REL } },
    );
  }
  const stripped = folder.replace(/\/+$/, '');
  return normalizeNotePath(`${stripped}/${trimmed}`);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDate(d: Date, fmt: string): string {
  // UTC components — keeps tests deterministic across CI timezones. Obsidian
  // itself uses local time; if a user needs that, they can pass `content`.
  const yyyy = String(d.getUTCFullYear());
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const min = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  return fmt
    .replace(/YYYY/g, yyyy)
    .replace(/MM/g, mm)
    .replace(/DD/g, dd)
    .replace(/HH/g, hh)
    .replace(/mm/g, min)
    .replace(/ss/g, ss);
}
