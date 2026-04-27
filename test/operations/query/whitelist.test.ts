import { describe, expect, it } from 'vitest';

import { ToolHandlerError } from '../../../src/lib/tool-response.js';
import { validateFilter } from '../../../src/modules/operations/query/whitelist.js';

describe('validateFilter', () => {
  it('accepts plain field equality', () => {
    expect(() => validateFilter({ 'frontmatter.status': 'active' })).not.toThrow();
  });

  it('accepts whitelisted operators', () => {
    expect(() =>
      validateFilter({
        'frontmatter.status': { $in: ['active', 'wip'] },
        'frontmatter.created': { $gte: '2026-01-01' },
        tags: { $regex: '^ai' },
      }),
    ).not.toThrow();
  });

  it('accepts $and / $or composition', () => {
    expect(() =>
      validateFilter({
        $and: [
          { tags: 'ai' },
          { $or: [{ 'frontmatter.status': 'active' }, { 'frontmatter.status': 'wip' }] },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects $where', () => {
    expect(() => validateFilter({ $where: 'true' })).toThrow(ToolHandlerError);
    expect(() => validateFilter({ $where: 'true' })).toThrow(/\$where/);
  });

  it('rejects $function', () => {
    expect(() => validateFilter({ $function: { body: '', args: [], lang: 'js' } })).toThrow(
      ToolHandlerError,
    );
  });

  it('rejects unknown $operators inside nested $and', () => {
    expect(() =>
      validateFilter({
        $and: [{ tags: 'ai' }, { 'frontmatter.x': { $unknownOp: 1 } }],
      }),
    ).toThrow(/\$unknownOp/);
  });

  it('rejects a top-level non-object filter', () => {
    expect(() => validateFilter([])).toThrow(ToolHandlerError);
    expect(() => validateFilter(null as unknown)).toThrow(ToolHandlerError);
    expect(() => validateFilter('string' as unknown)).toThrow(ToolHandlerError);
  });

  it('does not flag plain field names that happen to look weird', () => {
    expect(() =>
      validateFilter({
        'frontmatter.weird-key_with.dots': { $eq: 1 },
      }),
    ).not.toThrow();
  });
});
