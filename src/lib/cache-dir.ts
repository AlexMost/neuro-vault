import os from 'node:os';
import path from 'node:path';

/**
 * `$XDG_CACHE_HOME/neuro-vault`, else `~/.cache/neuro-vault`. A relative
 * `XDG_CACHE_HOME` is ignored, as the XDG spec requires — it would resolve
 * against whatever directory the MCP client launched us from. One rule for
 * the model cache and the daemon state, so they always sit side by side.
 */
export function neuroVaultCacheBase(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(home, '.cache');
  return path.join(base, 'neuro-vault');
}
