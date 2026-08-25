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

/** How long people get between being told and the box going down. */
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

  if (situation.preflight.unknown !== undefined) {
    return {
      action: "ask",
      why: "The box could not be inspected, so what an upgrade would destroy is unknown.",
      detail: describePreflight(situation.preflight),
    };
  }

  if (!isQuiet(situation.preflight)) {
    return {
      action: "ask",
      why: "Upgrading would destroy work that is not on a volume.",
      detail: describePreflight(situation.preflight),
    };
  }

  if (situation.protocolChanges === true) {
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
    if ((situation.waitingHours ?? 0) >= STALE_WAIT_HOURS) {
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

  return { action: "go", why: "Nothing is running, nobody is connected, and nothing would be lost." };
}

/**
 * What to say to the people who have to decide, or who are about to be interrupted.
 *
 * Written here rather than at each channel so every route says the same thing, and so the
 * wording is testable. It names what the upgrade costs before what it offers: a person
 * deciding needs the cost, and a person who only skims should still see it.
 */
export function upgradeMessage(decision: UpgradeDecision, boxName: string): string {
  switch (decision.action) {
    case "ask":
      return (
        `${boxName} has an upgrade waiting, and it needs you to decide.\n\n` +
        `${decision.why}\n\n${decision.detail}\n\n` +
        `Reply "upgrade" to go ahead, or leave it and nothing happens.`
      );
    case "announce":
      return (
        `${boxName} is upgrading in ${decision.minutes} minutes.\n\n` +
        `${decision.why} Open browser tabs and anything running in a shell will be lost; ` +
        `saved work and browser logins are kept.\n\n` +
        `Reply "wait" to postpone it.`
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
