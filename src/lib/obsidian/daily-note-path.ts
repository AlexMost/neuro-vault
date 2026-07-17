import { ToolHandlerError } from '../tool-response.js';

/**
 * Minimal moment-format renderer for Daily Notes basenames. Supports the
 * tokens Obsidian's default configs use (YYYY, YY, MM, M, DD, D), bracketed
 * literals, and passes every non-alphabetic character (e.g. '/', '-', '.')
 * through. Any other alphabetic token is a config this server cannot
 * resolve headlessly → DAILY_NOTES_NOT_CONFIGURED, same code the rest of
 * the daily preflight uses.
 */
export function formatDailyDate(format: string, date: Date): string {
  let out = '';
  let i = 0;
  while (i < format.length) {
    const ch = format[i]!;
    if (ch === '[') {
      const close = format.indexOf(']', i + 1);
      if (close === -1) throw unsupported(format, '[');
      out += format.slice(i + 1, close);
      i = close + 1;
    } else if (format.startsWith('YYYY', i)) {
      if (format[i + 4] === 'Y') throw unsupported(format, 'YYYYY');
      out += String(date.getFullYear()).padStart(4, '0');
      i += 4;
    } else if (format.startsWith('YY', i)) {
      if (format[i + 2] === 'Y') throw unsupported(format, 'YYY');
      out += String(date.getFullYear() % 100).padStart(2, '0');
      i += 2;
    } else if (format.startsWith('MM', i)) {
      if (format[i + 2] === 'M') throw unsupported(format, 'MMM');
      out += String(date.getMonth() + 1).padStart(2, '0');
      i += 2;
    } else if (ch === 'M') {
      out += String(date.getMonth() + 1);
      i += 1;
    } else if (format.startsWith('DD', i)) {
      if (format[i + 2] === 'D') throw unsupported(format, 'DDD');
      out += String(date.getDate()).padStart(2, '0');
      i += 2;
    } else if (ch === 'D') {
      out += String(date.getDate());
      i += 1;
    } else if (/[A-Za-z]/.test(ch)) {
      throw unsupported(format, ch);
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function unsupported(format: string, token: string): ToolHandlerError {
  return new ToolHandlerError(
    'DAILY_NOTES_NOT_CONFIGURED',
    `Daily Notes format "${format}" uses token "${token}" this server cannot render headlessly. ` +
      `Supported: YYYY, YY, MM, M, DD, D, [bracketed literals], and separators.`,
    { details: { format, token } },
  );
}
