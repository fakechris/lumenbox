/**
 * Who said yes to which upgrade, and to what it would cost.
 *
 * `decideUpgrade` answers "ask" when an upgrade would destroy something, and until now
 * nothing could carry the answer back: the web server told the admins and deliberately
 * does not perform upgrades, `agentbox box upgrade` performs them and cannot hear a chat.
 * Step 3 of docs/12 — *deciding* — was the one step with no code behind it, which is why
 * the notice ended up offering a reply verb that nothing implemented.
 *
 * This is that step, and it is a record rather than an action on purpose. The destructive
 * sequence (back up the volumes, recreate, verify, roll back if the box does not come
 * back) exists once, in the CLI, and is what docs/12 says must not be duplicated into a
 * server. So a person's decision is written down here and the existing path reads it: the
 * next `agentbox box upgrade` proceeds without asking instead of stopping at `--yes`.
 *
 * What is consented to is **not** "upgrade this box whenever". It is one image, and one
 * set of losses:
 *
 *  - The image, because approving 0.31 says nothing about 0.32.
 *  - A fingerprint of what the preflight found, because the person approved losing *those
 *    four files*. If a day's work has appeared in /home/box since, the fingerprint no
 *    longer matches and they are asked again — which is the whole point of having asked.
 *  - A deadline, because a situation can change in ways a fingerprint of the findings
 *    does not see (a job that started and finished between the two checks).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLine } from "./jsonl.ts";

/** How long a decision stays good. A day-old yes is about a box that no longer exists. */
export const CONSENT_GOOD_FOR_HOURS = 24;

export interface UpgradeConsent {
  /** The built image this answers for. */
  image: string;
  /** What the person was shown would be lost, as a fingerprint. */
  losses: string;
  /** The identity that decided, for the log and for whoever asks later who said yes. */
  by: string;
  at: string;
}

export function upgradeConsentPath(home: string): string {
  return join(home, "upgrade-consent.jsonl");
}

/**
 * A stable fingerprint of what an upgrade would destroy.
 *
 * Over `describePreflight`'s own text rather than over the structures behind it: that text
 * is what the person actually read, so it is the honest thing to hold them to. A change
 * nobody was shown cannot invalidate their answer, and nothing they were shown can change
 * without invalidating it.
 */
export function lossesFingerprint(detail: string): string {
  return createHash("sha256").update(detail).digest("hex").slice(0, 16);
}

/** Called where a person has just decided. Append-only: the record is also the audit. */
export function recordUpgradeConsent(path: string, consent: UpgradeConsent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendLine(path, JSON.stringify(consent));
}

/**
 * The decision that authorises upgrading to this image, given what it would now cost —
 * or undefined, which means nobody has answered *this* question.
 *
 * Read newest-first and stops at the first match: a person who approved, watched the
 * situation change, and approved again has two records, and the second is the live one.
 */
export function consentFor(
  path: string,
  image: string,
  losses: string,
  now = Date.now()
): UpgradeConsent | undefined {
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").split("\n").filter(line => line.trim() !== "");
  for (let index = lines.length - 1; index >= 0; index--) {
    let record: UpgradeConsent;
    try {
      record = JSON.parse(lines[index]!) as UpgradeConsent;
    } catch {
      // A torn line from a crash mid-append; keep looking at the ones that parse.
      continue;
    }
    if (record.image !== image || record.losses !== losses) continue;
    const age = now - Date.parse(record.at);
    if (!Number.isFinite(age) || age > CONSENT_GOOD_FOR_HOURS * 3_600_000) return undefined;
    return record;
  }
  return undefined;
}
