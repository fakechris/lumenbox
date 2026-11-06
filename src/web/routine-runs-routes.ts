/**
 * A routine's run history and the failure pause, from the page (INV-1665).
 *
 * `GET /api/schedules/runs?slug=` is read like `/api/schedules`: a run is no more secret than that
 * the routine exists, except that a run by an agent this caller may not read is left out. Changing
 * K — how many failures in a row pause a routine — is a driver's call, like pausing one by hand.
 * Resuming goes through `POST /api/schedules/resume`, the "Turn on" button's route, so a routine
 * has one way back on whoever stopped it.
 */

import type { Scheduler } from "../host/schedule.ts";
import { DONE_MEANS } from "../host/routine-runs.ts";

export async function routineRunsRoute(
  route: string,
  url: URL,
  scheduler: Scheduler,
  deps: {
    readJson: () => Promise<Record<string, unknown>>;
    refused: () => boolean;
    /** The agent a run's record names, as an id and a name the page can link to. */
    agentOf: (nameOrId: string) => { id: string; name: string } | undefined;
    mayReadAgent: (agentId: string) => boolean;
    /** The conversation a chatKey's runs land in. */
    conversationOf: (chatKey: string) => string;
  }
): Promise<{ status: number; body: unknown } | undefined> {
  if (route === "GET /api/schedules/runs") {
    const slug = url.searchParams.get("slug") ?? "";
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 20) || 20));
    const runs = scheduler.runs(slug, limit).flatMap(run => {
      const agent = run.agent === undefined ? undefined : deps.agentOf(run.agent);
      if (agent !== undefined && !deps.mayReadAgent(agent.id)) return [];
      return [{ ...run, ...(agent !== undefined ? { agentId: agent.id, agentName: agent.name, conversation: run.deliver !== undefined ? deps.conversationOf(run.deliver) : "main" } : {}) }];
    });
    const upcoming = (await scheduler.status()).find(entry => entry.slug === slug)?.upcoming ?? [];
    return { status: 200, body: { slug, runs, upcoming, hold: scheduler.holds.holdOf(slug) ?? null, failures: scheduler.holds.streakOf(slug), pauseAfter: scheduler.holds.pauseAfter, doneMeans: DONE_MEANS } };
  }
  if (route === "GET /api/schedules/pause-after") return { status: 200, body: { pauseAfter: scheduler.holds.pauseAfter } };
  if (route !== "POST /api/schedules/pause-after") return undefined;
  if (deps.refused()) return { status: 0, body: null };
  const body = await deps.readJson();
  try {
    scheduler.setPauseAfter(Number(body.pauseAfter));
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
  }
  return { status: 200, body: { pauseAfter: scheduler.holds.pauseAfter } };
}
