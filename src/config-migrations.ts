/**
 * One-time repairs to a config file written by an earlier version, applied as the config is
 * applied to the environment. Kept out of config.ts, which is at its size limit; the environment
 * is a parameter, handed in by config.ts.
 */

import type { AgentboxConfig } from "./config.ts";

export const MINIMAX_CN_KEY = "MINIMAX_CODE_CN_API_KEY";
const MINIMAX_GLOBAL_KEY = "MINIMAX_CODE_GLOBAL_API_KEY";

/**
 * Before #793 "MiniMax (global)" read the China preset's `MINIMAX_CODE_CN_API_KEY`, so that is
 * where every global key was saved; the preset now reads `MINIMAX_CODE_GLOBAL_API_KEY` (INV-2079).
 * When the global preset is in use — as the default or a fallback — and only the old name is set,
 * a saved key is copied to the new name in the file, once; the old name stays, since the China
 * preset may use it. A key exported in the shell is aliased for this process only and never
 * written to disk. A global key, when set anywhere, always wins. The log line names the variables
 * and never the value.
 *
 * `cnFromConfig` says the China key in `env` came from this config rather than the shell, which
 * is what makes the saved value the one in effect.
 */
export function migrateMinimaxGlobalKey(
  config: AgentboxConfig,
  env: NodeJS.ProcessEnv,
  cnFromConfig: boolean,
  save: (changes: Record<string, string>) => void,
  log: (line: string) => void
): AgentboxConfig {
  const inUse = [env.AGENTBOX_PROVIDER ?? config.provider, ...(config.fallbackProviders ?? [])];
  if (!inUse.some(name => name?.toLowerCase() === "minimax-global")) return config;
  if (env[MINIMAX_GLOBAL_KEY] || config.env?.[MINIMAX_GLOBAL_KEY]) return config;
  const saved = env[MINIMAX_CN_KEY] === undefined || cnFromConfig ? config.env?.[MINIMAX_CN_KEY] : undefined;
  if (saved) {
    save({ [MINIMAX_GLOBAL_KEY]: saved });
    log(`config: MiniMax (global) now reads ${MINIMAX_GLOBAL_KEY}; copied the saved ${MINIMAX_CN_KEY} to it`);
    return { ...config, env: { ...config.env, [MINIMAX_GLOBAL_KEY]: saved } };
  }
  if (env[MINIMAX_CN_KEY]) {
    env[MINIMAX_GLOBAL_KEY] = env[MINIMAX_CN_KEY];
    log(`MiniMax (global) now reads ${MINIMAX_GLOBAL_KEY}; using ${MINIMAX_CN_KEY} from the environment until it is set`);
  }
  return config;
}
