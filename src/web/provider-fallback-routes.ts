/**
 * The installation's fallback providers, set and seen by a person (INV-1578).
 *
 * - GET  /api/provider/fallbacks — the list, every preset with whether it has a key (a fallback
 *   without one is left out of a turn), and the last day's fallback spend by provider.
 * - POST /api/provider/fallbacks — { names: string[] }: at most three presets, in order. Admin only.
 * An agent's own list (its profile's `fallbackProviders`) wins over this one.
 */
import type { UsageRecord } from "../host/usage.ts";

export interface FallbackRouteDeps {
  refusedAdmin: () => boolean;
  readJson: () => Promise<Record<string, unknown>>;
  names: () => string[];
  save: (names: string[]) => void;
  presets: () => { name: string; label: string; model: string; hasKey: boolean }[];
  usage: () => UsageRecord[];
  now?: () => number;
}

export async function fallbackRoute(route: string, deps: FallbackRouteDeps): Promise<{ status: number; body: unknown } | undefined> {
  if (route !== "GET /api/provider/fallbacks" && route !== "POST /api/provider/fallbacks") return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: null };
  if (route === "POST /api/provider/fallbacks") {
    const raw = (await deps.readJson()).names;
    if (!Array.isArray(raw)) return { status: 400, body: { error: "names must be a list of provider presets." } };
    const known = new Set(deps.presets().map(preset => preset.name));
    const names = raw.map(String).map(name => name.trim()).filter(Boolean);
    const unknown = names.filter(name => !known.has(name));
    if (unknown.length > 0) return { status: 400, body: { error: `Not a provider preset: ${unknown.join(", ")}.` } };
    deps.save(names.slice(0, 3));
  }
  const since = (deps.now?.() ?? Date.now()) - 24 * 3_600_000;
  const spend = new Map<string, { provider: string; standingInFor: string; rounds: number; inputTokens: number; outputTokens: number }>();
  for (const row of deps.usage()) {
    if (row.fallbackFor === undefined || Date.parse(row.at) < since) continue;
    const key = `${row.provider}\0${row.fallbackFor}`;
    const entry = spend.get(key) ?? { provider: row.provider, standingInFor: row.fallbackFor, rounds: 0, inputTokens: 0, outputTokens: 0 };
    entry.rounds++; entry.inputTokens += row.inputTokens; entry.outputTokens += row.outputTokens;
    spend.set(key, entry);
  }
  return { status: 200, body: { names: deps.names(), presets: deps.presets(), lastDay: [...spend.values()] } };
}
