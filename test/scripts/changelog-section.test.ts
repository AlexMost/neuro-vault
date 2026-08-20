import { describe, expect, it } from 'vitest';
import { extractChangelogSection } from '../../scripts/changelog-section.js';

const CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## [15.1.0](https://github.com/AlexMost/neuro-vault/compare/v15.0.0...v15.1.0) (2026-08-10)

### Features

- newest thing ([42830d9](https://example.com/42830d9))

## [15.0.0](https://github.com/AlexMost/neuro-vault/compare/v14.0.0...v15.0.0) (2026-08-10)

### ⚠ BREAKING CHANGES

- **search:** query_stats.semantic is null when the semantic leg did not run

### Features

- breaking thing ([91a01a3](https://example.com/91a01a3))

## [1.1.0](https://github.com/AlexMost/neuro-vault/compare/v1.0.0...v1.1.0) (2026-04-12)

### Bug Fixes

- oldest thing ([c23efd5](https://example.com/c23efd5))
`;

describe('extractChangelogSection', () => {
  it('returns the section including its heading with the compare link', () => {
    const section = extractChangelogSection(CHANGELOG, '15.1.0');
    expect(section.startsWith('## [15.1.0](https://github.com/AlexMost')).toBe(true);
    expect(section).toContain('newest thing');
  });

  it('stops at the next version heading', () => {
    const section = extractChangelogSection(CHANGELOG, '15.1.0');
    expect(section).not.toContain('## [15.0.0]');
    expect(section).not.toContain('breaking thing');
    expect(section.endsWith('([42830d9](https://example.com/42830d9))')).toBe(true);
  });

  it('keeps the BREAKING CHANGES block of a major release', () => {
    const section = extractChangelogSection(CHANGELOG, '15.0.0');
    expect(section).toContain('### ⚠ BREAKING CHANGES');
    expect(section).toContain('query_stats.semantic is null');
    expect(section).not.toContain('newest thing');
    expect(section).not.toContain('oldest thing');
  });

  it('reads the last section up to end of file', () => {
    const section = extractChangelogSection(CHANGELOG, '1.1.0');
    expect(section).toContain('oldest thing');
    expect(section.endsWith('([c23efd5](https://example.com/c23efd5))')).toBe(true);
  });

  it('accepts a v-prefixed tag name', () => {
    expect(extractChangelogSection(CHANGELOG, 'v15.1.0')).toBe(
      extractChangelogSection(CHANGELOG, '15.1.0'),
    );
  });

  it('does not match a version that is only a prefix of another', () => {
    const changelog = `## [1.1.0](https://example.com/c) (2026-04-12)

- one one zero
`;
    expect(() => extractChangelogSection(changelog, '1.1')).toThrow(/1\.1/);
  });

  it('reads a first release whose heading has no compare link', () => {
    const changelog = `## [1.1.1](https://example.com/c) (2026-04-12)

- a patch

## 1.1.0 (2026-04-11)

- the very first release
`;
    expect(extractChangelogSection(changelog, 'v1.1.1')).toContain('a patch');
    expect(extractChangelogSection(changelog, 'v1.1.1')).not.toContain('very first');
    const first = extractChangelogSection(changelog, 'v1.1.0');
    expect(first.startsWith('## 1.1.0 (2026-04-11)')).toBe(true);
    expect(first).toContain('the very first release');
  });

  it('throws a named error when the version is absent', () => {
    expect(() => extractChangelogSection(CHANGELOG, '9.9.9')).toThrow(/9\.9\.9/);
  });
});
