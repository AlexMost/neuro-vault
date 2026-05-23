import { describe, expect, it } from 'vitest';

import {
  applyCoreTemplateSubstitutions,
  resolveAndRenderTemplate,
} from '../../../src/lib/obsidian/template-renderer.js';
import { ToolHandlerError } from '../../../src/lib/tool-response.js';

function fakeReadFile(map: Record<string, string | Error>) {
  return async (absPath: string, _enc: 'utf8'): Promise<string> => {
    const value = map[absPath];
    if (value === undefined) {
      const err = new Error(`ENOENT: ${absPath}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    if (value instanceof Error) throw value;
    return value;
  };
}

const NOW = new Date('2026-05-23T10:00:00Z');

describe('applyCoreTemplateSubstitutions', () => {
  it('substitutes {{title}}', () => {
    expect(applyCoreTemplateSubstitutions('# {{title}}', { title: 'Foo', now: NOW })).toBe('# Foo');
  });

  it('substitutes {{date}} as YYYY-MM-DD (UTC)', () => {
    expect(applyCoreTemplateSubstitutions('{{date}}', { title: '', now: NOW })).toBe('2026-05-23');
  });

  it('substitutes {{time}} as HH:mm (UTC)', () => {
    expect(applyCoreTemplateSubstitutions('{{time}}', { title: '', now: NOW })).toBe('10:00');
  });

  it('substitutes {{date:YYYY MM DD}} with custom format', () => {
    expect(applyCoreTemplateSubstitutions('{{date:YYYY MM DD}}', { title: '', now: NOW })).toBe(
      '2026 05 23',
    );
  });

  it('substitutes {{time:HH-mm-ss}} with custom format', () => {
    expect(applyCoreTemplateSubstitutions('{{time:HH-mm-ss}}', { title: '', now: NOW })).toBe(
      '10-00-00',
    );
  });

  it('passes through unknown {{tokens}} unchanged', () => {
    expect(applyCoreTemplateSubstitutions('{{foo}}', { title: '', now: NOW })).toBe('{{foo}}');
  });

  it('substitutes multiple tokens', () => {
    const body = '# {{title}}\n\nDate: {{date}}\nTime: {{time}}\n';
    expect(applyCoreTemplateSubstitutions(body, { title: 'Foo', now: NOW })).toBe(
      '# Foo\n\nDate: 2026-05-23\nTime: 10:00\n',
    );
  });

  it('substitutes tokens inside YAML frontmatter', () => {
    const body = '---\ntitle: {{title}}\ncreated: {{date}}\n---\n\nbody';
    expect(applyCoreTemplateSubstitutions(body, { title: 'Foo', now: NOW })).toBe(
      '---\ntitle: Foo\ncreated: 2026-05-23\n---\n\nbody',
    );
  });
});

describe('resolveAndRenderTemplate', () => {
  const VAULT = '/v';

  it('resolves a name via .obsidian/templates.json', async () => {
    const result = await resolveAndRenderTemplate({
      vaultRoot: VAULT,
      template: 'daily',
      title: 'Today',
      now: NOW,
      readFile: fakeReadFile({
        '/v/.obsidian/templates.json': JSON.stringify({ folder: 'Templates' }),
        '/v/Templates/daily.md': '# {{title}}\n{{date}}',
      }),
    });
    expect(result.path).toBe('Templates/daily.md');
    expect(result.rendered).toBe('# Today\n2026-05-23');
  });

  it('treats input as a path when it contains a slash', async () => {
    const result = await resolveAndRenderTemplate({
      vaultRoot: VAULT,
      template: 'Custom/daily',
      title: 'Today',
      now: NOW,
      readFile: fakeReadFile({
        '/v/Custom/daily.md': '{{title}}',
      }),
    });
    expect(result.path).toBe('Custom/daily.md');
    expect(result.rendered).toBe('Today');
  });

  it('treats input as a path when it ends in .md', async () => {
    const result = await resolveAndRenderTemplate({
      vaultRoot: VAULT,
      template: 'daily.md',
      title: 'Today',
      now: NOW,
      readFile: fakeReadFile({
        '/v/daily.md': '{{title}}',
      }),
    });
    expect(result.path).toBe('daily.md');
  });

  it('throws TEMPLATE_NOT_CONFIGURED when name-form used and templates.json missing', async () => {
    await expect(
      resolveAndRenderTemplate({
        vaultRoot: VAULT,
        template: 'daily',
        title: 'Today',
        now: NOW,
        readFile: fakeReadFile({}),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_CONFIGURED' });
  });

  it('throws TEMPLATE_NOT_CONFIGURED when templates.json has empty folder', async () => {
    await expect(
      resolveAndRenderTemplate({
        vaultRoot: VAULT,
        template: 'daily',
        title: 'Today',
        now: NOW,
        readFile: fakeReadFile({
          '/v/.obsidian/templates.json': JSON.stringify({ folder: '' }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_CONFIGURED' });
  });

  it('throws TEMPLATE_NOT_FOUND when the resolved file does not exist', async () => {
    await expect(
      resolveAndRenderTemplate({
        vaultRoot: VAULT,
        template: 'daily',
        title: 'Today',
        now: NOW,
        readFile: fakeReadFile({
          '/v/.obsidian/templates.json': JSON.stringify({ folder: 'Templates' }),
          // No /v/Templates/daily.md
        }),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });

  it('throws TEMPLATE_UNSUPPORTED when body contains Templater syntax', async () => {
    await expect(
      resolveAndRenderTemplate({
        vaultRoot: VAULT,
        template: 'tpl.md',
        title: 'Today',
        now: NOW,
        readFile: fakeReadFile({
          '/v/tpl.md': '<% tp.date.now() %>',
        }),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_UNSUPPORTED' });
  });

  it('detects <%* execution blocks too', async () => {
    await expect(
      resolveAndRenderTemplate({
        vaultRoot: VAULT,
        template: 'tpl.md',
        title: 'Today',
        now: NOW,
        readFile: fakeReadFile({
          '/v/tpl.md': 'pre <%* tp.user.foo() %> post',
        }),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_UNSUPPORTED' });
  });

  it('TEMPLATE_UNSUPPORTED message points to the content= workaround', async () => {
    try {
      await resolveAndRenderTemplate({
        vaultRoot: VAULT,
        template: 'tpl.md',
        title: 'Today',
        now: NOW,
        readFile: fakeReadFile({ '/v/tpl.md': '<% x %>' }),
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolHandlerError);
      expect((err as ToolHandlerError).message).toMatch(/Templater/);
      expect((err as ToolHandlerError).message).toMatch(/content/);
    }
  });
});
