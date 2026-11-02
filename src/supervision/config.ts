/**
 * The `supervision` section of config.json (INV-1527): what the app's supervision process runs.
 * Read raw beside the main loader, defaults for everything, so an old config file means "on".
 */

import { existsSync, readFileSync } from "node:fs";

export interface SupervisionConfig {
  watchdog: { enabled: boolean; stallMinutes: number; pausedMinutes: number; judge: boolean };
  supervisor: { model: string; maxMinutes: number; maxModelCalls: number; agent?: string; budget?: number };
}

export const DEFAULT_SUPERVISION: SupervisionConfig = {
  watchdog: { enabled: true, stallMinutes: 60, pausedMinutes: 30, judge: true },
  supervisor: { model: "gpt-6.1-sol", maxMinutes: 120, maxModelCalls: 60 },
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
      model: typeof s.model === "string" && s.model.trim() !== "" ? s.model.trim() : d.supervisor.model,
      maxMinutes: positive(s.maxMinutes, d.supervisor.maxMinutes),
      maxModelCalls: positive(s.maxModelCalls, d.supervisor.maxModelCalls),
      ...(typeof s.agent === "string" && s.agent.trim() !== "" ? { agent: s.agent.trim() } : {}),
      ...(typeof s.budget === "number" && s.budget > 0 ? { budget: s.budget } : {}),
    },
  };
}
