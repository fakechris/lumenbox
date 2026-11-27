/**
 * An activation makes the roster person (INV-2220, docs/109 §3): the one place the ledger's act
 * becomes a row in `principals.json`.
 *
 * The order is ledger, roster, ledger: the activation is written first (`Activations.activatePerson`
 * / `activateDepartment`), then `enrol` writes the roster once for everybody that act named, then
 * one `enrolled` line says who was made. A crash after the first step leaves a standing activation
 * with no `enrolled` line, and `enrol` run again — at the next server start, or by the home's format
 * migration — finishes it; a crash after the second leaves the person on the roster, and the run
 * again only writes the line. Somebody whose `enrolled` line exists is never made a second time, so
 * a person an Admin has since removed stays removed.
 *
 * Who the person is: id and identity `<door>:<subject>`, the name the directory gave, the role the
 * Admin chose. Somebody who left and is activated again comes back as the person they were, with
 * what they own. An identity that is already a roster person's is left exactly as it is.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Activations } from "./activations.ts";
import type { DirectorySource } from "./directory.ts";
import { Principals, type Principal } from "./principals.ts";

export interface Enrolled { subject: string; principalId: string }

type Roster = Pick<Principals, "reload" | "list" | "byId" | "isKnown" | "resolve" | "save" | "installation">;

/** Makes the roster people this source's standing activations are owed, and records them. Returns who is on the roster through it now. */
export function enrol(activations: Activations, principals: Roster, source: DirectorySource, options: { migrated?: boolean; log?: (line: string) => void } = {}): Enrolled[] {
  const waiting = activations.unenrolled(source);
  if (waiting.length === 0) return [];
  principals.reload();
  const identityOf = (subject: string) => `${source.channelId}:${subject}`;
  const before = principals.list();
  // A roster nobody is on has no Admin who could have activated anybody: not ours to start one from a ledger.
  if (principals.installation().mode !== "organisation" || before.length === 0) return [];
  let roster: Principal[] = before;
  for (const activation of waiting) {
    const identity = identityOf(activation.subject);
    if (principals.isKnown(identity)) continue;
    const back = principals.byId(activation.principalId ?? identity);
    roster = back !== undefined
      ? roster.map(person => person.id === back.id ? { ...person, role: activation.role, identities: [...person.identities, identity] } : person)
      : [...roster, { id: identity, name: activation.name || activation.subject, role: activation.role, identities: [identity] }];
  }
  if (roster !== before) principals.save(roster);
  const made = waiting.flatMap(activation => {
    const identity = identityOf(activation.subject);
    if (principals.isKnown(identity)) return [{ subject: activation.subject, principalId: principals.resolve(identity).id }];
    options.log?.(`activation of ${identity} made nobody: the roster does not hold that identity under the door as it is now`);
    return [];
  });
  activations.enrolled(source, made, options.migrated === true);
  return made;
}

/**
 * Home format 2: every activation that stands, made no roster person and has not left becomes one,
 * exactly as `enrol` makes them now. Only for a door `channels.json` still has at the incarnation
 * the activation was made against, and only for the app that door's newest ledger line names: an
 * activation of a replaced door or a replaced app admits nobody, as before. This reads the home
 * and nothing else, so it cannot see a door's app credentials as they are today; an app replaced
 * since the ledger's last line, under the same door id and incarnation, is the one case it cannot
 * tell, and there the door's id and incarnation are trusted as every roster link trusts them.
 * No box is made here: the running server does that afterwards.
 */
export function enrolStandingActivations(home: string): void {
  const rosterPath = join(home, "principals.json");
  const owed = standing(home);
  if (owed === undefined || owed.sources.length === 0) return;
  // The roster must be readable before it is rewritten: `Principals` reads a broken file as empty, and a save would then replace it.
  JSON.parse(readFileSync(rosterPath, "utf8"));
  const principals = new Principals(rosterPath, { incarnationOf: identity => owed.incarnations.get(identity.split(":")[0] ?? "") ?? 1, warn: () => {} });
  for (const source of owed.sources) enrol(owed.activations, principals, source, { migrated: true });
}

/**
 * Whether format 2 has anything to do in this home: at least one activation it would make a roster
 * person of. Asked before the home is copied, and of a home that may not be writable: it only
 * reads, and a home with no ledger, no roster, or door records it cannot read has nothing owed —
 * which is every personal installation.
 */
export function standingActivationsOwed(home: string): boolean {
  try { return (standing(home)?.sources.length ?? 0) > 0; } catch { return false; }
}

/** The ledger, and the doors in it whose standing activations made nobody yet. Reads only; a torn ledger line is skipped by the ledger itself. */
function standing(home: string): { activations: Activations; incarnations: Map<string, number>; sources: DirectorySource[] } | undefined {
  const ledger = join(home, "activations.jsonl"), channelsPath = join(home, "channels.json");
  if (!existsSync(ledger) || !existsSync(join(home, "principals.json")) || !existsSync(channelsPath)) return undefined;
  const incarnations = new Map<string, number>();
  const rows = (JSON.parse(readFileSync(channelsPath, "utf8")) as { channels?: unknown }).channels;
  for (const row of Array.isArray(rows) ? rows as { id?: unknown; incarnation?: unknown }[] : []) {
    if (typeof row?.id === "string" && typeof row.incarnation === "number") incarnations.set(row.id, row.incarnation);
  }
  const activations = new Activations(ledger);
  const sources = activations.latestSources().filter(source => incarnations.get(source.channelId) === source.incarnation && activations.unenrolled(source).length > 0);
  return { activations, incarnations, sources };
}
