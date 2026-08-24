import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The one place `package.json` is read at runtime — consumed by the CLI's
 * `--version` flag and by the MCP server identity.
 *
 * The path is resolved against the *emitted* file, not this source file: tsup
 * flattens the whole bundle into `dist/cli.js` and never rewrites this literal
 * string. `src/` and `dist/` sit at the same depth under the package root, so
 * `'../package.json'` is correct from both — which is exactly why this module
 * must stay at `src/` root depth and not move under `src/lib/`. A deeper path
 * would still pass every source-level test and break the published binary.
 */
export const packageMeta = require('../package.json') as {
  name: string;
  version: string;
};
