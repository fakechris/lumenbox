/**
 * The `supervision` section of config.json (INV-1527): what the app's supervision process runs.
 * Read raw beside the main loader, defaults for everything, so an old config file means "on".
 */

import { existsSync, readFileSync } from "node:fs";

export interface SupervisionConfig {
  watchdog: { enabled: boolean; stallMinutes: number; pausedMinutes: number; judge: boolean };
  supervisor: { provider: string; model: string; maxMinutes: number; maxModelCalls: number; agent?: string; budget?: number };
}

export const DEFAULT_SUPERVISION: SupervisionConfig = {
  watchdog: { enabled: true, stallMinutes: 60, pausedMinutes: 30, judge: true },
  supervisor: { provider: "openai", model: "gpt-6.1-sol", maxMinutes: 120, maxModelCalls: 60 },
};

const positive = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);

export function readSupervisionConfig(path: string): SupervisionConfig {
  if (!existsSync(path)) return structuredClone(DEFAULT_SUPERVISION);
  let raw: { supervision?: { watchdog?: Record<string, unknown>; supervisor?: Record<string, unknown> } };
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return structuredClone(DEFAULT_SUPERVISION);
  }
  const w = raw.supervision?.watchdog ?? {};
  const s = raw.supervision?.supervisor ?? {};
  const d = DEFAULT_SUPERVISION;
  return {
    watchdog: {
      enabled: w.enabled !== false,
      stallMinutes: positive(w.stallMinutes, d.watchdog.stallMinutes),
      pausedMinutes: positive(w.pausedMinutes, d.watchdog.pausedMinutes),
      judge: w.judge !== false,
    },
    supervisor: {
      provider: typeof s.provider === "string" && s.provider.trim() !== "" ? s.provider.trim() : d.supervisor.provider,
      model: typeof s.model === "string" && s.model.trim() !== "" ? s.model.trim() : d.supervisor.model,
      maxMinutes: positive(s.maxMinutes, d.supervisor.maxMinutes),
      maxModelCalls: positive(s.maxModelCalls, d.supervisor.maxModelCalls),
      ...(typeof s.agent === "string" && s.agent.trim() !== "" ? { agent: s.agent.trim() } : {}),
      ...(typeof s.budget === "number" && s.budget > 0 ? { budget: s.budget } : {}),
    },
  };
}

/** What a settings save may write: validated, defaults filled, nothing else (INV-1528). */
export function supervisionFromBody(body: Record<string, unknown>, current: SupervisionConfig): SupervisionConfig | { error: string } {
  const w = (body.watchdog ?? {}) as Record<string, unknown>;
  const s = (body.supervisor ?? {}) as Record<string, unknown>;
  const minutes = (value: unknown, fallback: number, name: string): number | { error: string } => {
    if (value === undefined) return fallback;
    const n = Number(value);
    return Number.isFinite(n) && n >= 1 && n <= 24 * 60 ? Math.round(n) : { error: `${name} is a number of minutes between 1 and 1440` };
  };
  const stall = minutes(w.stallMinutes, current.watchdog.stallMinutes, "stall minutes");
  const paused = minutes(w.pausedMinutes, current.watchdog.pausedMinutes, "paused minutes");
  const maxMinutes = minutes(s.maxMinutes, current.supervisor.maxMinutes, "run minutes");
  for (const checked of [stall, paused, maxMinutes]) if (typeof checked !== "number") return checked;
  const calls = s.maxModelCalls === undefined ? current.supervisor.maxModelCalls : Number(s.maxModelCalls);
  if (!Number.isInteger(calls) || calls < 1 || calls > 500) return { error: "model calls is a whole number between 1 and 500" };
  const budget = s.budget === undefined || s.budget === null || s.budget === "" ? undefined : Number(s.budget);
  if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) return { error: "budget is a positive number of input-token equivalents, or empty for none" };
  const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() !== "" ? value.trim() : fallback);
  const agent = s.agent === undefined ? current.supervisor.agent : typeof s.agent === "string" && s.agent.trim() !== "" ? s.agent.trim() : undefined;
  return {
    watchdog: {
      enabled: w.enabled === undefined ? current.watchdog.enabled : w.enabled === true,
      stallMinutes: stall as number,
      pausedMinutes: paused as number,
      judge: w.judge === undefined ? current.watchdog.judge : w.judge === true,
    },
    supervisor: {
      provider: text(s.provider, current.supervisor.provider),
      model: text(s.model, current.supervisor.model),
      maxMinutes: maxMinutes as number,
      maxModelCalls: calls,
      ...(agent !== undefined ? { agent } : {}),
      ...(s.budget === undefined ? (current.supervisor.budget !== undefined ? { budget: current.supervisor.budget } : {}) : budget !== undefined ? { budget } : {}),
    },
  };
}

