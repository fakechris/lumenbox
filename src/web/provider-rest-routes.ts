/**
 * A provider account that is out of usage, seen and nudged by a person (INV-1577).
 *
 * - GET  /api/provider/rests — every account resting now: which provider, since when, until when, why.
 * - POST /api/provider/rests/retry — { account }: end the rest now, so the next call checks whether the
 *   plan is back (after a top-up, say). Admin only.
 */
import type { ProviderRests } from "../host/provider-rest.ts";

export interface ProviderRestDeps {
  refusedAdmin: () => boolean;
  readJson: () => Promise<Record<string, unknown>>;
  rests: ProviderRests;
  /** Window forecast, hold, and the disposition name. Omitted by callers that have not wired it. */
  quotaLine?: () => string;
}

export async function providerRestRoute(route: string, deps: ProviderRestDeps): Promise<{ status: number; body: unknown } | undefined> {
  if (route !== "GET /api/provider/rests" && route !== "POST /api/provider/rests/retry") return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: null };
  if (route === "GET /api/provider/rests") {
    const quota = deps.quotaLine?.();
    return { status: 200, body: { rests: deps.rests.list(), ...(quota !== undefined && quota !== "" ? { quota } : {}) } };
  }
  const account = String((await deps.readJson()).account ?? "");
  return deps.rests.retryNow(account)
    ? { status: 200, body: { retrying: true } }
    : { status: 404, body: { error: "That account is not resting." } };
}

/** What admins are told, once when a rest begins and once when it ends. */
export function restNotice(event: { type: "resting" | "recovered"; state: { label: string; until: string; reason: string } }): string {
  return event.type === "resting"
    ? `${event.state.label} says its plan is out of usage (${event.state.reason.slice(0, 160)}). Every agent on it waits until ${new Date(event.state.until).toLocaleString()} rather than retrying; top up the plan or choose Retry now in Settings → Model.`
    : `${event.state.label} answers again; agents are back on it.`;
}
