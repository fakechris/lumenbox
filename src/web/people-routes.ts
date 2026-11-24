/**
 * Managing the people of an installation (INV-2053, INV-2054, INV-2056, INV-2057): the People list an
 * admin reads (each person's doors, when they were last active, their personal-box quota and use),
 * removing a person, and the invitation codes — for a new person, or a sign-in code bound to one already
 * on the roster, so the person who comes back is the same principal with the same boxes and agents.
 *
 * The roster always keeps an admin: removing the last one, or saving a roster without one, is refused
 * here rather than trusted to the page, because one click on the wrong row cannot be undone.
 */
import { apiError } from "./api-error.ts";
import { invitationLink } from "./sign-in.ts";
import type { Principal, Principals, Role } from "../host/principals.ts";
import type { Invite } from "../host/invite-redeem.ts";
import { doorOfIdentity } from "../host/self-merge.ts";

/** A live code: who it admits (or links), what the admin wrote it is for, and until when. */
export interface PendingInvite extends Invite { note?: string }

/** How long a code may last: fifteen minutes unless the admin chose longer. */
export const INVITE_MINUTES = [15, 60, 24 * 60, 7 * 24 * 60] as const;
const NOTE_LIMIT = 80;

export function inviteMinutes(value: unknown): number {
  return INVITE_MINUTES.find(minutes => minutes === value) ?? INVITE_MINUTES[0];
}

/** A roster that once had an admin and would have none: the change that locks everyone out of the settings. */
export function leavesNoAdmin(before: readonly Pick<Principal, "role">[], after: readonly Pick<Principal, "role">[]): boolean {
  return before.some(person => person.role === "admin") && !after.some(person => person.role === "admin");
}

export interface PeopleDeps {
  principals: Principals;
  invites: Map<string, PendingInvite>;
  newCode: () => string;
  refusedAdmin: () => boolean;
  readJson: () => Promise<Record<string, unknown>>;
  signOut: (principalId: string) => void;
  planRemoval: (person: Principal, kept: Principal[], disposition: unknown) => () => Promise<void>;
  /** Personal boxes: the quota that applies to the person (null: none) and how many they hold. */
  boxesOf: (principalId: string) => { quota: number | null; held: number };
  /** When each person last did something: wrote through a door, spent, or opened the app. */
  lastActive: (people: readonly Principal[]) => Map<string, string>;
  doorType: (door: string) => string | undefined;
  publicUrl: string | undefined;
  callerId: () => string | undefined;
  log: (line: string) => void;
  now?: () => number;
}

type Reply = { status: number; body: unknown };

export async function peopleRoute(route: string, deps: PeopleDeps): Promise<Reply | undefined> {
  const removing = route === "POST /api/principals/remove";
  const revoking = route === "POST /api/principals/revoke-sign-in";
  if (route !== "GET /api/people" && !removing && !revoking && route !== "POST /api/channels/invite") return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: undefined };
  const now = (deps.now ?? Date.now)();
  const { principals, invites } = deps;
  principals.reload();
  if (!removing && !revoking)
    for (const [code, invite] of invites) if (invite.expiresAt < now) invites.delete(code);

  if (route === "GET /api/people") {
    const people = principals.list(), active = deps.lastActive(people), admins = people.filter(person => person.role === "admin").length;
    const me = deps.callerId(), self = me === undefined || !principals.isKnown(me) ? undefined : principals.resolve(me).id;
    return {
      status: 200,
      body: {
        installation: principals.installation(),
        people: people.map(person => ({
          id: person.id, name: person.name, role: person.role, identities: person.identities,
          doors: [...new Set(person.identities.map(doorOfIdentity))].map(door => ({ door, ...(deps.doorType(door) ? { type: deps.doorType(door) } : {}) })),
          ...(active.has(person.id) ? { lastActive: active.get(person.id) } : {}),
          boxes: deps.boxesOf(person.id),
          lastAdmin: person.role === "admin" && admins === 1,
          self: person.id === self,
        })),
        invites: [...invites.entries()].map(([code, invite]) => ({
          code, role: invite.role, expiresAt: invite.expiresAt,
          ...(invite.principalId !== undefined ? { principalId: invite.principalId, name: principals.byId(invite.principalId)?.name } : {}),
          ...(invite.note !== undefined ? { note: invite.note } : {}),
        })),
      },
    };
  }

  const body = await deps.readJson();
  principals.reload();
  if (deps.refusedAdmin()) return { status: 0, body: undefined };

  if (removing || revoking) {
    const roster = principals.list(), person = principals.byId(String(body.principalId ?? ""));
    if (person === undefined) return { status: 404, body: apiError("person-unknown", { person: String(body.principalId ?? "") }) };
    if (revoking) {
      const identity = body.identity;
      if (typeof identity !== "string" || !person.identities.includes(identity))
        return { status: 404, body: apiError("sign-in-unknown") };
      const identities = person.identities.filter(entry => entry !== identity);
      if (identities.length === 0) return { status: 409, body: apiError("sign-in-last") };
      principals.save(roster.map(entry => entry.id === person.id ? { ...entry, identities } : entry));
      return { status: 200, body: { principals: principals.list() } };
    }
    const kept = roster.filter(entry => entry.id !== person.id);
    if (leavesNoAdmin(roster, kept)) return { status: 409, body: apiError("last-admin") };
    let dispose: () => Promise<void>;
    try { dispose = deps.planRemoval(person, kept, body.disposition); }
    catch (error) { return { status: 409, body: { error: (error as Error).message } }; }
    principals.save(kept);
    deps.signOut(person.id);
    for (const [code, invite] of invites) if (invite.principalId === person.id) invites.delete(code);
    deps.log(`principal removed: ${person.name} (${person.id}) by ${deps.callerId() ?? "the operator"}`);
    try { await dispose(); }
    catch (error) { return { status: 409, body: { error: (error as Error).message } }; }
    return { status: 200, body: { principals: principals.list() } };
  }

  // A code for somebody on the roster links a new door to them: same human, another phone, or back after
  // being signed out. Without a principalId it admits a new person at the named role (an organisation only, INV-1689).
  const principalId = typeof body.principalId === "string" && body.principalId !== "" ? body.principalId : undefined;
  const person = principalId === undefined ? undefined : principals.byId(principalId);
  if (principalId === undefined) principals.requireOrganisation();
  else if (person === undefined) return { status: 404, body: apiError("person-unknown", { person: principalId }) };
  const role: Role = person?.role ?? (body.role === "admin" || body.role === "viewer" ? body.role : "driver");
  const note = typeof body.note === "string" ? body.note.trim().slice(0, NOTE_LIMIT) : "";
  const minutes = inviteMinutes(body.minutes);
  const code = deps.newCode();
  const invite: PendingInvite = { role, ...(person ? { principalId: person.id } : {}), ...(note ? { note } : {}), expiresAt: now + minutes * 60_000 };
  invites.set(code, invite);
  deps.log(`channel invite: ${person ? `for ${person.name}` : role}, ${minutes} min, created`); // never the code: a log reader could redeem it
  const forPerson = person ? { principalId: person.id, name: person.name } : {};
  return { status: 200, body: { code, ...invite, ...forPerson, minutes, ...invitationLink(deps.publicUrl, code) } }; // the link the app accepts (INV-1701)
}
