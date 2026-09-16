/**
 * Deciding whether to upgrade a box now, later, or only once somebody says so.
 *
 * The tempting design is a setting — automatic upgrades on or off — and it is the wrong
 * axis. The same upgrade is free at four in the morning on an idle box and rude at two in
 * the afternoon while three people are watching an agent work, and no single switch can be
 * right for both. What decides is what the upgrade costs *at that moment*.
 *
 * So this is a pure function of the situation, kept apart from everything that performs an
 * upgrade, because the judgement is the part worth being sure about and the part that is
 * otherwise impossible to test: you cannot easily arrange a half-broken box with two people
 * watching at 3am.
 *
 * The principle is the one the approval gate already uses. Act when it costs nobody
 * anything; ask when a person would want to have been asked.
 */

import type { Preflight } from "../box/preflight.ts";
import { describePreflight, isQuiet } from "../box/preflight.ts";

/**
 * How long an upgrade may sit waiting for its quiet window before it stops waiting and
 * asks instead.
 *
 * A window nobody's machine is ever awake for is a box that never upgrades and never says
 * why, which looks exactly like a feature that does not work.
 */
export const STALE_WAIT_HOURS = 24 * 7;

/**
 * The word the notice asks for, and the word the channel manager answers to.
 *
 * Named once, exported, and asserted in a test against the parser on the other side. The
 * failure this prevents is the one that started all of this: a message that names a verb
 * nothing handles reads exactly like a working feature right up until somebody uses it.
 */
export const UPGRADE_WORD = "upgrade";

/**
 * How long people get between being told and the box going down.
 *
 * Carried on the decision and deliberately not quoted in the announcement: nothing that
 * sends an announcement also performs an upgrade, so a countdown in the text would be a
 * clock nobody is running. It is here for whatever eventually honours it.
 */
export const ANNOUNCE_MINUTES = 10;

export interface UpgradeSituation {
  /**
   * Why the box cannot currently serve, if it cannot — a refused version handshake, a
   * failed verification, a desktop that will not start.
   */
  boxFailing?: string;
  /** What recreating the box would destroy. */
  preflight: Preflight;
  /** How many people are connected and watching right now. */
  watching: number;
  /** Whether this image also changes the protocol, so a client may need upgrading too. */
  protocolChanges?: boolean;
  /** The local hour an unattended upgrade is allowed. Absent means any hour will do. */
  quietHour?: number;
  /** The hour it is now, locally. */
  hour: number;
  /** How long this upgrade has already waited for its window. */
  waitingHours?: number;
  /**
   * Whether a person has already been asked about *this* image and these findings, and
   * said yes (`upgrade-consent.ts`).
   *
   * A boolean rather than the consent itself, because matching a decision to a situation
   * is the caller's job and a delicate one — the image must be the same image and the
   * losses the same losses — and this function's whole value is being a pure statement of
   * the rules over a situation somebody else established.
   */
  approved?: boolean;
}

export type UpgradeDecision =
  /** The box is already not serving, so the upgrade is the repair. Do it now. */
  | { action: "repair"; why: string }
  /** Somebody has to decide, and here is what they need to know. */
  | { action: "ask"; why: string; detail: string }
  /** Safe, but people are here. Tell them, give them a chance to stop it. */
  | { action: "announce"; why: string; minutes: number }
  /** Safe and unattended, but not the right hour yet. */
  | { action: "wait"; why: string }
  /** Nobody pays anything. Go. */
  | { action: "go"; why: string };

/**
 * What to do about an available upgrade.
 *
 * Ordered deliberately: the first two rules are about whether an upgrade is *safe*, and
 * they come before every rule about whether it is *convenient*. A broken box is not made
 * better by waiting for 4am, and work that would be destroyed is not made expendable by
 * everyone happening to be asleep.
 */
export function decideUpgrade(situation: UpgradeSituation): UpgradeDecision {
  if (situation.boxFailing !== undefined) {
    // Ahead of the preflight on purpose. A box nobody can use has little left to protect,
    // and the check that would protect it is the one that cannot run on a broken box.
    return {
      action: "repair",
      why: `The box is not working (${situation.boxFailing}), so upgrading it is the repair rather than a risk to it.`,
    };
  }

  // A question already answered is not asked again. Every rule below this line up to the
  // watching check exists to put a decision in front of a person; the caller has
  // established that a person saw *this* image and *these* findings and said yes, so
  // re-asking is not caution, it is the notice nobody reads.
  //
  // Deliberately only these. What a person authorised is the loss — they were shown a
  // list of files and a list of jobs and accepted them. They said nothing about whether
  // now is a good moment, so the rules about interrupting people and about the quiet
  // window still apply underneath, unchanged.
  const decided = situation.approved === true;

  if (!decided && situation.preflight.unknown !== undefined) {
    return {
      action: "ask",
      why: "The box could not be inspected, so what an upgrade would destroy is unknown.",
      detail: describePreflight(situation.preflight),
    };
  }

  if (!decided && !isQuiet(situation.preflight)) {
    return {
      action: "ask",
      why: "Upgrading would destroy work that is not on a volume.",
      detail: describePreflight(situation.preflight),
    };
  }

  if (!decided && situation.protocolChanges === true) {
    // Not merely disruptive: anything talking to this box may stop working until it is
    // upgraded too, and that is not a decision to take on somebody's behalf at 4am.
    return {
      action: "ask",
      why: "This image changes the protocol, so whatever drives this box may need upgrading with it.",
      detail: "Nothing would be lost, but connections from an older host will be refused until it is updated.",
    };
  }

  if (situation.watching > 0) {
    const people = situation.watching === 1 ? "1 person is" : `${situation.watching} people are`;
    return {
      action: "announce",
      why: `${people} connected. Upgrading closes their tabs and stops whatever they are watching.`,
      minutes: ANNOUNCE_MINUTES,
    };
  }

  if (situation.quietHour !== undefined && situation.quietHour !== situation.hour) {
    if (!decided && (situation.waitingHours ?? 0) >= STALE_WAIT_HOURS) {
      return {
        action: "ask",
        why:
          `This upgrade has been waiting ${Math.floor((situation.waitingHours ?? 0) / 24)} days ` +
          `for the ${situation.quietHour}:00 window and has not had one.`,
        detail:
          "Either the machine is never awake at that hour or the window is wrong. " +
          "Upgrade now, or pick an hour this box is actually running.",
      };
    }
    return {
      action: "wait",
      why: `Nothing to lose and nobody here, but the upgrade window is ${situation.quietHour}:00.`,
    };
  }

  // The reason has to be the real one. "Nothing would be lost" is what makes an
  // unattended upgrade defensible, and it is false for an approved one — something *would*
  // be lost, and a person looked at the list and accepted it. Saying so is the difference
  // between a log line that explains a destroyed file and one that contradicts it.
  return {
    action: "go",
    why: decided
      ? "Somebody was shown what this would destroy and approved it."
      : "Nothing is running, nobody is connected, and nothing would be lost.",
  };
}

/**
 * What to say to the people who have to decide, or who are about to be interrupted.
 *
 * Written here rather than at each channel so every route says the same thing, and so the
 * wording is testable. It names what the upgrade costs before what it offers: a person
 * deciding needs the cost, and a person who only skims should still see it.
 *
 * **It may not offer anything nothing implements.** The first version ended `Reply
 * "upgrade" to go ahead` and `Reply "wait" to postpone it`, and no such handler existed
 * anywhere — replying did nothing, in silence. The cost of that is not one wasted reply:
 * somebody read "reply to go ahead", reasonably concluded the bot could act on the box,
 * and asked the agent in the chat to back the listed files up (2026-09-15). A button that
 * is not wired is worse than no button, because the next real notice is not believed
 * either.
 *
 * `UPGRADE_WORD` is now wired — `parseUpgradeApproval` in the channel manager answers it,
 * and a test asserts that the word this message names is the word that manager parses, so
 * the two cannot drift apart again. What it does is stated exactly, including what it does
 * not do: it records a decision, and the box is recreated by the upgrade run that reads
 * it, not by the reply. `"wait"` is still unimplemented and so is still not offered.
 */
export function upgradeMessage(decision: UpgradeDecision, boxName: string): string {
  switch (decision.action) {
    case "ask":
      return (
        `${boxName} has an upgrade waiting, and it needs you to decide.\n\n` +
        `${decision.why}\n\n${decision.detail}\n\n` +
        `Reply "${UPGRADE_WORD}" to approve it. That records your decision and nothing ` +
        `else — the box is recreated by the next upgrade run, which will then stop ` +
        `asking. Or leave it and nothing happens.`
      );
    case "announce":
      return (
        `${boxName} has an upgrade waiting, and taking it will interrupt you.\n\n` +
        `${decision.why} Open browser tabs and anything running in a shell will be lost; ` +
        `saved work and browser logins are kept.\n\n` +
        `This is a warning, not a countdown: it happens when somebody runs ` +
        `\`agentbox box upgrade\`. Replying here does not postpone it — finish what is on ` +
        `the screen, or say so to whoever runs it.`
      );
    case "repair":
      return `${boxName} is being upgraded now: ${decision.why}`;
    case "wait":
      return `${boxName} has an upgrade waiting. ${decision.why}`;
    case "go":
      return `${boxName} is upgrading. ${decision.why}`;
  }
}


/**
 * Who to tell, given the roster.
 *
 * Every admin, not one nominated one. A nominated admin is a single point of absence —
 * they go on holiday, change phone, or leave — and a box that only one person may upgrade
 * is a box that stops being upgraded. Whoever answers first decides; the rest find out
 * what was decided.
 *
 * Drivers and viewers are deliberately not here. They are told when they are *about to be
 * interrupted*, which is a different message sent to whoever is connected, not a question
 * about whether the installation should change.
 */
export function adminRecipients(
  principals: readonly { role: string; identities: readonly string[] }[]
): { adapter: string; identity: string }[] {
  const found: { adapter: string; identity: string }[] = [];
  for (const principal of principals) {
    if (principal.role !== "admin") continue;
    for (const identity of principal.identities) {
      const adapter = identity.split(":")[0] ?? "";
      // A web identity has no channel to push to; that person sees it on the page.
      if (adapter === "" || adapter === "web") continue;
      found.push({ adapter, identity });
    }
  }
  return found;
}
