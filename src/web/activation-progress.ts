/**
 * What an activation asks of the cluster before the press, and how its boxes are doing after it
 * (INV-2220, docs/109 §3 "Many at once"): the Admin's side of the box queue.
 *
 * - **The estimate**: the people a department activation would make, how many boxes that starts
 *   now, how many are out of quota, and the memory those boxes ask for — one box's request as the
 *   allocator places it (`PersonalBoxDriver.memoryRequest`), times the boxes. A press that would
 *   start boxes is refused until the Admin has confirmed exactly that number.
 * - **The progress**: for everybody an activation asked a box for, one state — ready, starting,
 *   queued, failed (with the platform's reason) or out of quota — and whether they were told.
 *   Counted by state; the people of one state are read fifty at a time, so a department of
 *   hundreds is a line of counts until somebody opens one.
 * - **Again**: retry the failed boxes, tell again the people not told — one person, or all.
 */

import type { Activation, ActivationEstimate, Activations } from "../host/activations.ts";
import type { AssistantReady } from "../host/assistant-ready.ts";
import type { AutoPersonalBoxes } from "../host/auto-personal-box.ts";
import type { DirectorySource } from "../host/directory.ts";
import type { PersonalBoxes } from "../host/personal-boxes.ts";
import type { Principals, Role } from "../host/principals.ts";
import { quantityBytes } from "../control/policy.ts";

export interface OnboardingDeps {
  autoBoxes: Pick<AutoPersonalBoxes, "estimate" | "queued" | "view" | "retryFailed" | "waiting">;
  boxes: Pick<PersonalBoxes, "list" | "memoryRequest">;
  ready: Pick<AssistantReady, "notTold" | "tellAgain">;
  /** A personal-box quota by the identity somebody not yet on the roster will hold, as the directory places them. */
  quotaOf(identity: string): number | undefined;
  /** The name a box made for this person is given, in their language. */
  boxName(person: { id: string; name: string }): string;
}

export type BoxProgress = "ready" | "starting" | "queued" | "failed" | "quota";
export const PROGRESS_STATES: readonly BoxProgress[] = ["ready", "starting", "queued", "failed", "quota"];
const PAGE = 50;

/** What activating these identities at this role would start now. */
export function estimateOf(ids: readonly string[], role: Role, deps: OnboardingDeps): ActivationEstimate {
  const { boxes, outOfQuota } = deps.autoBoxes.estimate(ids, role, deps.quotaOf);
  const memoryRequest = deps.boxes.memoryRequest() ?? null, each = memoryRequest === null ? undefined : quantityBytes(memoryRequest);
  return { people: ids.length, boxes, outOfQuota, memoryRequest, memoryBytes: each === undefined ? null : each * boxes };
}

/** Where one person's box stands, from its record and the queue. */
function progressOf(principalId: string, deps: OnboardingDeps): { state: BoxProgress; reason?: string } {
  if (deps.autoBoxes.queued(principalId)) return { state: "queued" };
  const box = deps.boxes.list(principalId)[0];
  // Out of the queue a box record exists at once (the reservation is synchronous): none means it was not made.
  if (box === undefined) return deps.autoBoxes.view(principalId)?.state === "quota" ? { state: "quota" } : { state: "failed", reason: "NotStarted" };
  if (box.status === "ready") return { state: "ready" };
  if (box.status === "provisioning") return { state: "starting" };
  return { state: "failed", reason: box.stateReason ?? box.error ?? box.status };
}

/** Everybody this source's activations asked a box for, standing — and the ones out of quota, for whom none was asked, so the Admins see who needs a raise. */
function asked(activations: Activations, source: DirectorySource, deps: OnboardingDeps): Activation[] {
  const waiting = deps.autoBoxes.waiting();
  return activations.activations(source).filter(activation => activation.leftAt === undefined && activation.principalId !== undefined
    && (activation.boxAskedAt !== undefined || (activation.migrated !== true && waiting.has(activation.principalId))));
}

/** The counts, and the people of one state (or the ones not told) a page at a time. */
export function progress(activations: Activations, source: DirectorySource, deps: OnboardingDeps, show?: { state: string; offset: number }) {
  const rows = asked(activations, source, deps).map(activation => ({ activation, ...progressOf(activation.principalId!, deps) }));
  const counts = Object.fromEntries(PROGRESS_STATES.map(state => [state, rows.filter(row => row.state === state).length])) as Record<BoxProgress, number>;
  const notTold = deps.ready.notTold(source);
  const chosen = show === undefined ? [] : show.state === "not-told"
    ? notTold.map(activation => ({ activation, state: undefined as BoxProgress | undefined, reason: undefined as string | undefined }))
    : rows.filter(row => row.state === show.state);
  const page = chosen.sort((a, b) => a.activation.name.localeCompare(b.activation.name)).slice(show?.offset ?? 0, (show?.offset ?? 0) + PAGE);
  return {
    counts, notTold: notTold.length, latest: rows.map(row => row.activation.boxAskedAt ?? row.activation.at).sort().at(-1) ?? null,
    ...(show !== undefined ? {
      total: chosen.length, offset: show.offset,
      people: page.map(({ activation, state, reason }) => ({
        subject: activation.subject, name: activation.name, ...(state !== undefined ? { state } : {}), ...(reason !== undefined ? { reason } : {}),
        ...(activation.told !== undefined ? { told: activation.told } : {}),
      })),
    } : {}),
  };
}

/** The failed boxes of these people (or every failed one), started again a few at a time. */
export function retryBoxes(activations: Activations, source: DirectorySource, subjects: readonly string[] | undefined, deps: OnboardingDeps, principals: Pick<Principals, "byId">): number {
  const people = asked(activations, source, deps).filter(activation => (subjects === undefined || subjects.includes(activation.subject)) && progressOf(activation.principalId!, deps).state === "failed")
    .flatMap(activation => { const person = principals.byId(activation.principalId!); return person === undefined ? [] : [{ id: person.id, name: person.name }]; });
  return deps.autoBoxes.retryFailed(people, deps.boxName).length;
}
