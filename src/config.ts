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

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AgentboxConfig {
  /**
   * How many recent events the web UI keeps so a page opened later still shows what
   * happened. Not a record of the run — the transcripts on disk are that — so this is
   * bounded, and every event above the limit is dropped oldest-first.
   */
  activityLimit: number;
  /**
   * The default provider preset, for when neither `--provider` nor `AGENTBOX_PROVIDER`
   * says otherwise.
   *
   * This exists because the choice used to live only in the launch command, and a
   * restart that forgot the flag silently switched to a different company's model with
   * a credential that could not work. Which provider you use is decided once, which is
   * the definition of what belongs in this file.
   */
  provider?: string;
  /** Model override, applied exactly as `--model` is — only when nothing else set one. */
  model?: string;
  /** Base URL for the `custom` preset, applied only when `AGENTBOX_BASE_URL` is not set. */
  baseUrl?: string;
  /**
   * Environment variables applied at startup, under the real environment: a variable
   * already set in the shell always wins. This is where an API key lives when it is not
   * exported in a profile — the file is written 0600 and stays on this machine; nothing
   * from it is placed inside the box.
   */
  env?: Record<string, string>;
  /**
   * Who may drive the agents from a chat channel, as `channel:id` strings
   * (`telegram:123456`, `feishu:ou_abc`, `dingtalk:staff1`).
   *
   * Empty or absent means nobody: a bot handle is discoverable, and "anyone who
   * finds it owns your machine" is not a default anyone chose. An unauthorised
   * sender is told their own id, which is exactly what the owner needs to add here.
   */
  channelAllow?: string[];
  /**
   * Letting an agent run commands on this machine, outside the box.
   *
   * Off unless an operator turns it on, because it is the one door through the box's
   * wall — the way an agent reaches a USB device, an AppleScript, or a `pi`/`claude`
   * CLI on the host. Enabled, every host command still pauses for approval; `cwd` is
   * the directory those commands run under, and there is no default for it because a
   * default would be this code choosing what an agent may reach on someone's machine.
   */
  hostExec?: {
    enabled?: boolean;
    cwd?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
  };
  /**
   * MCP servers whose tools the agents may use, by name.
   *
   * Operator-only, and in this file rather than in any UI an agent can reach: a stdio
   * server is a process on this machine with this machine's privileges — the same class
   * of decision as `hostExec`, and not one an agent should be able to make for itself.
   * An agent is a caller of these tools, never an installer of them.
   */
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  /**
   * Chats that asked for a daily digest, chatKey → local hour (0–23). Written by the
   * chat itself ("早报 8点" / "digest at 8"); in the file so the schedule survives a
   * restart, which is the whole difference between a digest and a reply.
   */
  digests?: Record<string, number>;
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
    ...(readString(raw.provider, "provider", onWarn) !== undefined
      ? { provider: readString(raw.provider, "provider", onWarn) }
      : {}),
    ...(readString(raw.model, "model", onWarn) !== undefined
      ? { model: readString(raw.model, "model", onWarn) }
      : {}),
    ...(readString(raw.baseUrl, "baseUrl", onWarn) !== undefined
      ? { baseUrl: readString(raw.baseUrl, "baseUrl", onWarn) }
      : {}),
    ...(readEnvMap(raw.env, onWarn) !== undefined ? { env: readEnvMap(raw.env, onWarn) } : {}),
    ...(readStringList(raw.channelAllow, "channelAllow", onWarn) !== undefined
      ? { channelAllow: readStringList(raw.channelAllow, "channelAllow", onWarn) }
      : {}),
    ...(readHostExec(raw.hostExec, onWarn) !== undefined
      ? { hostExec: readHostExec(raw.hostExec, onWarn) }
      : {}),
    ...(readDigests(raw.digests, onWarn) !== undefined
      ? { digests: readDigests(raw.digests, onWarn) }
      : {}),
    ...(readMcpServers(raw.mcpServers, onWarn) !== undefined
      ? { mcpServers: readMcpServers(raw.mcpServers, onWarn) }
      : {}),
  };
}

function readMcpServers(
  value: unknown,
  warn: (message: string) => void
): AgentboxConfig["mcpServers"] {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warn("config: mcpServers must be an object of name to {command, args}, ignoring it");
    return undefined;
  }
  const servers: NonNullable<AgentboxConfig["mcpServers"]> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      warn(`config: mcpServers.${name} must be an object, ignoring it`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.command !== "string" || entry.command === "") {
      warn(`config: mcpServers.${name} needs a command, ignoring it`);
      continue;
    }
    // The name travels into tool names, where a separator or a space would make the
    // routing ambiguous — refused here rather than producing an uncallable tool.
    if (!/^[A-Za-z0-9-]+$/.test(name)) {
      warn(`config: mcpServers.${name} — a server name may only be letters, digits and -`);
      continue;
    }
    const args = Array.isArray(entry.args)
      ? entry.args.filter((value): value is string => typeof value === "string")
      : undefined;
    const env =
      entry.env !== null && typeof entry.env === "object" && !Array.isArray(entry.env)
        ? Object.fromEntries(
            Object.entries(entry.env as Record<string, unknown>).filter(
              (pair): pair is [string, string] => typeof pair[1] === "string"
            )
          )
        : undefined;
    servers[name] = {
      command: entry.command,
      ...(args !== undefined && args.length > 0 ? { args } : {}),
      ...(env !== undefined && Object.keys(env).length > 0 ? { env } : {}),
    };
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}

function readDigests(
  value: unknown,
  warn: (message: string) => void
): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warn("config: digests must be an object of chatKey to hour, ignoring it");
    return undefined;
  }
  const digests: Record<string, number> = {};
  for (const [key, hour] of Object.entries(value as Record<string, unknown>)) {
    if (typeof hour === "number" && Number.isInteger(hour) && hour >= 0 && hour <= 23) {
      digests[key] = hour;
    } else {
      warn(`config: digests["${key}"] must be an hour 0-23, ignoring it`);
    }
  }
  return Object.keys(digests).length > 0 ? digests : undefined;
}

function readHostExec(
  value: unknown,
  warn: (message: string) => void
): AgentboxConfig["hostExec"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    warn("config: hostExec must be an object, ignoring it");
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const result: NonNullable<AgentboxConfig["hostExec"]> = {};
  if (typeof raw.enabled === "boolean") result.enabled = raw.enabled;
  if (typeof raw.cwd === "string" && raw.cwd.trim() !== "") result.cwd = raw.cwd.trim();
  if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)) {
    result.timeoutMs = raw.timeoutMs;
  }
  if (typeof raw.maxOutputBytes === "number" && Number.isFinite(raw.maxOutputBytes)) {
    result.maxOutputBytes = raw.maxOutputBytes;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function readStringList(
  value: unknown,
  key: string,
  warn: (message: string) => void
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    warn(`config: ${key} must be an array of strings, ignoring it`);
    return undefined;
  }
  const list = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return list.length > 0 ? list.map(item => item.trim()) : undefined;
}

function readString(
  value: unknown,
  key: string,
  warn: (message: string) => void
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    warn(`config: ${key} must be a non-empty string, ignoring it`);
    return undefined;
  }
  return value.trim();
}

/** String-to-string only; anything else in the map is dropped with a warning, not the map. */
function readEnvMap(
  value: unknown,
  warn: (message: string) => void
): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    warn("config: env must be an object of variable names to values, ignoring it");
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") env[key] = entry;
    else warn(`config: env.${key} must be a string, ignoring it`);
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * The config file as a second environment, applied under the real one.
 *
 * Only variables the shell did not already set: an exported variable always wins, so a
 * one-off `AGENTBOX_MODEL=... agentbox web` still behaves as typed. Called once at
 * startup by the commands that resolve a provider — by the time this process runs,
 * anything that could change how Node itself starts is already decided, so these values
 * only affect this program's own lookups.
 */
export function applyConfigEnv(config: AgentboxConfig): void {
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  if (config.model !== undefined && process.env.AGENTBOX_MODEL === undefined) {
    process.env.AGENTBOX_MODEL = config.model;
  }
  if (config.baseUrl !== undefined && process.env.AGENTBOX_BASE_URL === undefined) {
    process.env.AGENTBOX_BASE_URL = config.baseUrl;
  }
}

/**
 * Merges the given fields into the config file and rewrites it.
 *
 * Read-merge-write on the raw JSON rather than on the parsed type, so keys this version
 * does not know about — written by hand, or by a later version — survive the save
 * instead of being silently stripped. `undefined` leaves a field alone; `null` deletes
 * it, which is how the UI clears an override.
 *
 * 0600, because the env map may hold an API key. The whole home directory is private
 * already; the file's own mode says so a second time.
 */
export function saveConfig(
  changes: Partial<Record<"provider" | "model" | "baseUrl", string | null>> & {
    env?: Record<string, string | null>;
    channelAllow?: string[] | null;
    hostExec?: AgentboxConfig["hostExec"] | null;
    /** Per-chat patch: a null hour removes that chat's digest, others are left alone. */
    digests?: Record<string, number | null>;
  }
): string {
  const path = configPath();
  let raw: Record<string, unknown> = { ...DEFAULT_CONFIG };
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // Unreadable is treated as absent: the save was asked for, and keeping a broken
      // file instead would fail every future load too.
    }
  }

  for (const key of ["provider", "model", "baseUrl"] as const) {
    const value = changes[key];
    if (value === undefined) continue;
    if (value === null) delete raw[key];
    else raw[key] = value;
  }
  if (changes.channelAllow !== undefined) {
    if (changes.channelAllow === null || changes.channelAllow.length === 0) {
      delete raw.channelAllow;
    } else {
      raw.channelAllow = changes.channelAllow;
    }
  }
  if (changes.hostExec !== undefined) {
    if (changes.hostExec === null) delete raw.hostExec;
    else raw.hostExec = changes.hostExec;
  }
  if (changes.digests !== undefined) {
    const current =
      raw.digests !== null && typeof raw.digests === "object" && !Array.isArray(raw.digests)
        ? { ...(raw.digests as Record<string, unknown>) }
        : {};
    for (const [key, hour] of Object.entries(changes.digests)) {
      if (hour === null) delete current[key];
      else current[key] = hour;
    }
    if (Object.keys(current).length > 0) raw.digests = current;
    else delete raw.digests;
  }
  if (changes.env !== undefined) {
    const current =
      raw.env !== null && typeof raw.env === "object" && !Array.isArray(raw.env)
        ? { ...(raw.env as Record<string, unknown>) }
        : {};
    for (const [key, value] of Object.entries(changes.env)) {
      if (value === null) delete current[key];
      else current[key] = value;
    }
    if (Object.keys(current).length > 0) raw.env = current;
    else delete raw.env;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // The mode argument only applies when the file is created; an existing 0644 file
  // would keep its bits, and this save may be the one that first puts a key in it.
  chmodSync(path, 0o600);
  return path;
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
