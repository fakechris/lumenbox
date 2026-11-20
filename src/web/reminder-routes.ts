/**
 * The reminders members set for themselves, on the automations page (INV-1878).
 *
 * `GET /api/reminders` is read like `/api/schedules`: what is waiting to start by itself, less the
 * ones of a member this caller may not read. `POST /api/reminders/dismiss` drops one so it never
 * fires — a driver's call, like pausing a routine. Both read the pending-work ledger through
 * reminders.ts; nothing about a reminder is kept here.
 */

import type { PendingWork } from "../host/pending-work.ts";
import { apiError } from "./api-error.ts";
import { cancelReminder, pendingReminders } from "../host/reminders.ts";

export async function reminderRoute(
  route: string,
  ledger: PendingWork | undefined,
  deps: {
    readJson: () => Promise<Record<string, unknown>>;
    refused: () => boolean;
    agentName: (agentId: string) => string | undefined;
    mayReadAgent: (agentId: string) => boolean;
  }
): Promise<{ status: number; body: unknown } | undefined> {
  if (route === "GET /api/reminders") {
    const reminders = ledger === undefined ? [] : pendingReminders(ledger).filter(reminder => deps.mayReadAgent(reminder.agentId));
    return { status: 200, body: { reminders: reminders.map(reminder => ({ ...reminder, agentName: deps.agentName(reminder.agentId) ?? reminder.agentId })) } };
  }
  if (route !== "POST /api/reminders/dismiss") return undefined;
  if (deps.refused()) return { status: 0, body: null };
  const id = String((await deps.readJson()).id ?? "");
  const waiting = ledger === undefined ? undefined : pendingReminders(ledger).find(reminder => reminder.id === id && deps.mayReadAgent(reminder.agentId));
  if (ledger === undefined || waiting === undefined) return { status: 404, body: apiError("reminder-not-waiting", { id }) };
  cancelReminder(ledger, id);
  return { status: 200, body: { ok: true, id } };
}
