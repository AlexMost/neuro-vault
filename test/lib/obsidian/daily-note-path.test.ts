import { describe, expect, it } from 'vitest';

import { formatDailyDate } from '../../../src/lib/obsidian/daily-note-path.js';

const d = new Date(2026, 6, 16); // 2026-07-16 local

describe('formatDailyDate', () => {
  it('renders the Obsidian default', () => {
    expect(formatDailyDate('YYYY-MM-DD', d)).toBe('2026-07-16');
  });
  it('renders folder-splitting formats', () => {
    expect(formatDailyDate('YYYY/MM/YYYY-MM-DD', d)).toBe('2026/07/2026-07-16');
  });
  it('renders short tokens and two-digit year', () => {
    expect(formatDailyDate('D.M.YY', d)).toBe('16.7.26');
  });
  it('passes bracketed literals through', () => {
    expect(formatDailyDate('[day-]YYYY-MM-DD', d)).toBe('day-2026-07-16');
  });
  it('rejects unsupported tokens with DAILY_NOTES_NOT_CONFIGURED', () => {
    expect(() => formatDailyDate('YYYY-MMMM-DD', d)).toThrowError(
      expect.objectContaining({ code: 'DAILY_NOTES_NOT_CONFIGURED' }),
    );
  });
  it('rejects a five-Y year token instead of silently splitting it', () => {
    // 'YYYYY' must not render as YYYY + stray literal — the leftover 'Y' is
    // an unsupported token.
    expect(() => formatDailyDate('YYYYY-MM-DD', d)).toThrowError(
      expect.objectContaining({ code: 'DAILY_NOTES_NOT_CONFIGURED' }),
    );
  });
  it('rejects longer year runs instead of rendering them (YYYYYY, YYYYYYYY)', () => {
    // Regression: 'YYYYYY' must not split into YYYY+YY ("202626"), and
    // 'YYYYYYYY' must not become YYYY+YYYY ("20262026").
    for (const fmt of ['YYYYYY-MM-DD', 'YYYYYYYY']) {
      expect(() => formatDailyDate(fmt, d)).toThrowError(
        expect.objectContaining({ code: 'DAILY_NOTES_NOT_CONFIGURED' }),
      );
    }
  });
  it('rejects an unclosed bracketed literal', () => {
    expect(() => formatDailyDate('[day-YYYY-MM-DD', d)).toThrowError(
      expect.objectContaining({
        code: 'DAILY_NOTES_NOT_CONFIGURED',
        details: expect.objectContaining({ token: '[' }),
      }),
    );
  });
});
