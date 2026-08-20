/**
 * Cut one version's section out of CHANGELOG.md.
 *
 * The release-notes workflow (.github/workflows/release-notes.yml) pipes the
 * result into `gh release create --notes-file`, so the CHANGELOG stays the
 * single source of truth for release notes — GitHub's `--generate-notes` would
 * list PR titles and drop the `⚠ BREAKING CHANGES` blocks.
 *
 * Usage: tsx scripts/changelog-section.ts <version|tag> [changelog-path]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Version headings are `## [1.2.3](compare-link) (date)` — except the very
// first release, which commit-and-tag-version writes without a compare link.
const HEADING = /^## (?:\[|\d)/m;

/** Strips a leading `v` so both `v15.1.0` and `15.1.0` address the same section. */
export function normalizeVersion(versionOrTag: string): string {
  return versionOrTag.replace(/^v/, '');
}

/**
 * Returns the `## [version]` section, heading (with its compare link) included,
 * up to the next version heading or end of file. Throws when absent — a missing
 * section means the tag and the CHANGELOG disagree, which must fail loudly.
 */
export function extractChangelogSection(changelog: string, versionOrTag: string): string {
  const version = normalizeVersion(versionOrTag);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = changelog.search(new RegExp(`^## (?:\\[${escaped}\\]|${escaped} )`, 'm'));

  if (start === -1) {
    throw new Error(`No section for version ${version} in the changelog`);
  }

  const rest = changelog.slice(start);
  const nextRelative = rest.slice(1).search(HEADING);
  const section = nextRelative === -1 ? rest : rest.slice(0, nextRelative + 1);

  return section.trimEnd();
}

function main(argv: string[]): void {
  const [versionOrTag, changelogArg] = argv;

  if (versionOrTag === undefined) {
    throw new Error('Usage: tsx scripts/changelog-section.ts <version|tag> [changelog-path]');
  }

  const changelogPath =
    changelogArg ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');

  process.stdout.write(
    `${extractChangelogSection(readFileSync(changelogPath, 'utf8'), versionOrTag)}\n`,
  );
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && path.resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
