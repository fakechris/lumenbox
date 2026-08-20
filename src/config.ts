/**
 * Settings that belong in a file rather than in an environment variable.
 *
 * Everything else here is configured per run: which provider, which model, where the
 * box is. Those suit environment variables, because they change between invocations.
 * A few settings are not like that — someone decides once how much activity the UI
 * should keep and expects it to stay decided — and re-exporting a variable in every
 * shell to hold a preference is the wrong shape for it.
 *
 * ~/.agentbox/config.json, next to the token and the agent directories.
 *
 * Read defensively on purpose. This file is meant to be edited by hand, so a stray
 * comma or a value someone typed as a string must not stop the UI from starting: bad
 * input falls back to the default and says so. Unknown keys are ignored, so a config
 * written by a later version still loads.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AgentboxConfig {
  /**
   * How many recent events the web UI keeps so a page opened later still shows what
   * happened. Not a record of the run — the transcripts on disk are that — so this is
   * bounded, and every event above the limit is dropped oldest-first.
   */
  activityLimit: number;
}

export const DEFAULT_CONFIG: AgentboxConfig = {
  activityLimit: 400,
};

/** Above this, a page would spend its first seconds rendering history. */
const MAX_ACTIVITY_LIMIT = 20_000;

export function agentboxHome(): string {
  return process.env.AGENTBOX_HOME ?? join(homedir(), ".agentbox");
}

export function configPath(): string {
  return process.env.AGENTBOX_CONFIG ?? join(agentboxHome(), "config.json");
}

function readInteger(
  value: unknown,
  fallback: number,
  bounds: { min: number; max: number },
  key: string,
  warn: (message: string) => void
): number {
  if (value === undefined) return fallback;

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    warn(`config: ${key} must be a whole number, using ${fallback}`);
    return fallback;
  }
  if (parsed < bounds.min || parsed > bounds.max) {
    const clamped = Math.min(Math.max(parsed, bounds.min), bounds.max);
    warn(`config: ${key} must be between ${bounds.min} and ${bounds.max}, using ${clamped}`);
    return clamped;
  }
  return parsed;
}

/** The config as written, with defaults for anything missing or unusable. */
export function loadConfig(onWarn: (message: string) => void = () => {}): AgentboxConfig {
  const path = configPath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    onWarn(`config: ${path} is not valid JSON (${detail}), using defaults`);
    return { ...DEFAULT_CONFIG };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    onWarn(`config: ${path} should contain an object, using defaults`);
    return { ...DEFAULT_CONFIG };
  }

  const raw = parsed as Record<string, unknown>;
  return {
    activityLimit: readInteger(
      raw.activityLimit,
      DEFAULT_CONFIG.activityLimit,
      { min: 1, max: MAX_ACTIVITY_LIMIT },
      "activityLimit",
      onWarn
    ),
  };
}

/**
 * Writes the defaults if there is no config yet, and returns the path.
 *
 * A config file nobody can find is not configurable. Writing it on first run makes the
 * settings and their values visible in an editor instead of documented somewhere else.
 */
export function ensureConfigFile(): string {
  const path = configPath();
  if (existsSync(path)) return path;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
  return path;
}

/**
 * A number from the environment, or the default if it is not one.
 *
 * Every tunable in this system used to be read as `Number(process.env.X ?? default)`, in
 * forty-two places. `Number("4000x")` is `NaN`, and every comparison against `NaN` is false — so a
 * single typo in a variable name's *value* did not fall back to the default, it removed the limit.
 * `AGENTBOX_MEMORY_BUDGET=4000x` put the entire memory file into every system prompt; a mistyped
 * budget or round cap would have been worse.
 *
 * Loud, because a silently ignored setting is indistinguishable from one that had no effect: the
 * person who set it watches the thing they configured not happen, and looks for the bug in the
 * product.
 *
 * Finiteness only. Callers who need a range say so themselves, because "positive" is right for a
 * budget, wrong for a nice value, and meaningless for a port of zero.
 */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(`[config] ${name}="${raw}" is not a number; using ${fallback}`);
    return fallback;
  }
  return value;
}
