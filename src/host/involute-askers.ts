/**
 * Who may put a question to our agents on Involute (INV-575, docs/54 §3.6).
 *
 * INV-553 shipped with `config.involute.askers`: a hand-typed list of Involute actor ids.
 * That was the blunt first version, and it answered the wrong question — whether an id is
 * on a list — when the question this installation asks of everyone else is *who is this
 * person here, what may they do, and are they in this box*. Being able to comment on a work
 * item over there is not being able to start a turn on this machine.
 *
 * So an Involute actor is one more identity a Principal can hold, `involute:<actorId>`,
 * exactly like `feishu:ou_x` or `telegram:123`: linked in Settings → People, resolved by
 * the roster, retired with its incarnation. Then the two ordinary questions apply —
 * `roleAtLeast(driver)`, because a viewer reads and does not command, and `mayEnterBox`
 * for the box the agent lives in, because authority is the box's (docs/22 §0).
 *
 * `askers` stays as a transition. When a principal link exists it decides, whatever the
 * list says; the list is consulted only for an actor nobody has linked, and the log says
 * which rule spoke. A refusal is always in words a person can act on — the one thing worse
 * than being refused is being refused with a UUID.
 */

import { mayEnterBox, refusalToEnter } from "../box/membership.ts";
import type { BoxEntry } from "../box/boxes.ts";
import { type Principal, roleAtLeast } from "./principals.ts";

export const INVOLUTE_IDENTITY_PREFIX = "involute:";

/** The identity string a Principal holds for an Involute actor. */
export function involuteIdentity(actorId: string): string {
  return `${INVOLUTE_IDENTITY_PREFIX}${actorId.trim()}`;
}

export interface AskerDeps {
  /** The roster: an unknown identity resolves to an ad-hoc viewer named after itself. */
  resolve: (identity: string) => Principal;
  isKnown: (identity: string) => boolean;
  /** The box the agent lives in — its name for the refusal, its members for the rule. */
  boxOf: (agentId: string) => Pick<BoxEntry, "name" | "members">;
  /** The transitional allowlist of actor ids. Absent or empty means there is none. */
  askers?: readonly string[];
}

export type AskerVerdict =
  | { ok: true; via: "principal" | "askers"; who: string }
  | { ok: false; why: string };

/**
 * Whether this agent may answer this actor, and by which rule.
 *
 * Order matters and is deliberate: a linked person is judged as a person even if their id
 * is also on the old list — otherwise unlinking someone would silently fall through to the
 * list and let them back in.
 */
export function mayAnswerFrom(deps: AskerDeps, input: { agentId: string; requestedByActorId: string | undefined }): AskerVerdict {
  const actorId = input.requestedByActorId?.trim() ?? "";
  if (actorId === "") return { ok: false, why: "the request does not say who asked, so I cannot tell whether I may answer" };

  const identity = involuteIdentity(actorId);
  if (deps.isKnown(identity)) {
    const person = deps.resolve(identity);
    if (!roleAtLeast(person.role, "driver")) {
      return {
        ok: false,
        why: `${person.name} is a ${person.role} on this installation; starting a turn needs a driver or admin. An admin can change that in Settings → People.`,
      };
    }
    const box = deps.boxOf(input.agentId);
    if (!mayEnterBox(box, person.id)) return { ok: false, why: refusalToEnter(box.name, person.name) };
    return { ok: true, via: "principal", who: person.name };
  }

  const askers = deps.askers ?? [];
  if (askers.includes(actorId)) return { ok: true, via: "askers", who: actorId };

  return {
    ok: false,
    why:
      `I do not know who you are on this installation. Ask an admin to link your Involute identity ` +
      `(${identity}) to you in Settings → People; once linked as a driver in this agent's box, I can answer.`,
  };
}
