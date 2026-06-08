import { describe, expect, it } from 'vitest';
import {
  previewBody,
  PREVIEW_CHAR_CAP,
  PREVIEW_MARKER,
} from '../../src/modules/operations/preview-body.js';

describe('previewBody', () => {
  it('returns body unchanged with truncated:false when body is short', () => {
    expect(previewBody('short body')).toEqual({ content: 'short body', truncated: false });
  });

  it('returns empty string unchanged with truncated:false', () => {
    expect(previewBody('')).toEqual({ content: '', truncated: false });
  });

  it('returns body unchanged with truncated:false when length equals PREVIEW_CHAR_CAP', () => {
    const body = 'a'.repeat(PREVIEW_CHAR_CAP);
    expect(previewBody(body)).toEqual({ content: body, truncated: false });
  });

  it('truncates at last whitespace before cap, appends marker, truncated:true', () => {
    // Build a body that has a whitespace exactly at index 10, then runs past the cap
    const prefix = 'hello world'; // single space at index 5; last char 'd' at index 10
    const suffix = ' '.repeat(0) + 'x'.repeat(PREVIEW_CHAR_CAP); // pushes total well past cap
    const body = prefix + suffix;
    const result = previewBody(body);
    expect(result.truncated).toBe(true);
    // Only whitespace is the space at index 5; cut there, trimEnd removes it → 'hello'
    expect(result.content).toBe('hello' + PREVIEW_MARKER);
  });

  it('hard-cuts at cap when body has no whitespace before cap, appends marker, truncated:true', () => {
    const noSpaceBody = 'x'.repeat(PREVIEW_CHAR_CAP + 50);
    const result = previewBody(noSpaceBody);
    expect(result.truncated).toBe(true);
    expect(result.content.endsWith(PREVIEW_MARKER)).toBe(true);
    expect(result.content).toBe('x'.repeat(PREVIEW_CHAR_CAP) + PREVIEW_MARKER);
  });

  it('cuts at word boundary when body exceeds cap and whitespace exists before cap', () => {
    // "word " repeated so we cross the cap cleanly at a space boundary
    const word = 'abcde '; // 6 chars per word
    const repeated = word.repeat(Math.ceil((PREVIEW_CHAR_CAP + 100) / word.length));
    const result = previewBody(repeated);
    expect(result.truncated).toBe(true);
    // Last space in segment is at index 497 (= 6*82+5); cut there, trimEnd is a no-op.
    // Pre-marker content: 82 full 'abcde ' words + 'abcde' = 497 chars.
    expect(result.content).toBe('abcde '.repeat(82) + 'abcde' + PREVIEW_MARKER);
  });
});
