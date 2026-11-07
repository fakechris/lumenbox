/**
 * Redeeming an invite code, one rule for both surfaces that take one — `bind CODE` in a chat and
 * the web sign-in (docs/22 §4, docs/48 §3). A code made for somebody already on the roster links
 * the new identity to them: same human, another door. On a personal installation that is the only
 * kind of code there is — the Owner's own, for a second phone, a second Feishu app (whose
 * open_id differs from the first app's for the same person), DingTalk or a browser (INV-1698) —
 * so redeeming it never adds a person and never meets the INV-1689 refusal.
 *
 * A code made for an id that a merge folded into someone (INV-1698) links to that someone: the
 * lookup is `byId`, which reads aliases. A code made for an id nobody holds any more is refused
 * rather than read as "a new person": that would let a stale code mint a stranger.
 */
import type { Principal, Principals, Role } from "./principals.ts";

export interface Invite {
  role: Role;
  /** Set: the code links a new identity to this person. Unset: it admits a new person (an organisation only). */
  principalId?: string;
  expiresAt: number;
}

export type Redeemed =
  | { kind: "linked"; person: Principal }
  | { kind: "joined"; person: Principal }
  | { kind: "gone" };

/** Links `identity` to the invite's person, or admits a new person named `name` at the invite's role. Throws `PersonalInstallationOnly` for a new person on a personal installation. */
export function redeemInvite(principals: Principals, invite: Invite, identity: string, name: string): Redeemed {
  principals.reload();
  const roster = principals.list();
  if (invite.principalId !== undefined) {
    const person = principals.byId(invite.principalId);
    const target = person === undefined ? undefined : roster.find(entry => entry.id === person.id);
    if (target === undefined) return { kind: "gone" };
    target.identities.push(identity);
    principals.save(roster);
    return { kind: "linked", person: principals.byId(target.id) ?? target };
  }
  const person: Principal = { id: identity, name, role: invite.role, identities: [identity] };
  principals.save([...roster, person]);
  return { kind: "joined", person };
}
