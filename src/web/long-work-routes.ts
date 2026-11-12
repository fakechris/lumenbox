/**
 * The ceiling on what the host continues unattended, from the page (INV-1823, INV-1825).
 *
 * One request that outgrows its turn is carried on by the host, on the operator's own model budget.
 * How far is theirs to say, for the whole installation: this reads and writes `longWork` in the
 * config file. Reading is anybody's; changing it is an admin's.
 */
import { loadConfig, saveConfig } from "../config.ts";
import { longRequestLimits } from "../host/long-request.ts";
import { apiError } from "./api-error.ts";

const whole = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;

export async function longWorkRoute(
  route: string,
  deps: { readJson: () => Promise<Record<string, unknown>>; refusedAdmin: () => boolean }
): Promise<{ status: number; body: unknown } | undefined> {
  if (route !== "GET /api/long-work" && route !== "POST /api/long-work") return undefined;
  const view = () => {
    const limits = longRequestLimits(loadConfig().longWork), defaults = longRequestLimits();
    return { continuations: limits.continuations, activeHours: limits.activeMs / 3_600_000, defaults: { continuations: defaults.continuations, activeHours: defaults.activeMs / 3_600_000 } };
  };
  if (route === "GET /api/long-work") return { status: 200, body: view() };
  if (deps.refusedAdmin()) return { status: 0, body: null };
  const body = await deps.readJson();
  const continuations = whole(body.continuations, 0, 1000), activeHours = whole(body.activeHours, 1, 168);
  if (continuations === undefined || activeHours === undefined) return { status: 400, body: apiError("long-work-range") };
  saveConfig({ longWork: { continuations, activeHours } });
  return { status: 200, body: view() };
}
