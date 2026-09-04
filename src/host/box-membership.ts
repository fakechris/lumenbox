/**
 * Who may reach a box (docs/22 §2, item 5; docs/35 §3).
 *
 * One check, asked at every admission point — the door, the web, the desktop
 * route — against the box's own record:
 *
 * > outer gate passed ∧ principal ∈ box.members
 *
 * Three bindings, one cardinality rule (docs/22 §0): `everyone` is today's
 * honest box; `listed` is a hand-picked set; `department` is the subtree of a
 * synced org, resolved **at admission time** — a hand-picked set of people
 * goes stale the day the vendor moves someone, a binding to the structure
 * cannot. That live resolution is the one amendment this makes to docs/22
 * §1, per docs/35 §3.
 *
 * The direct operator has no identity and needs no membership: the person
 * running the machine must never be locked out of it by data they did not
 * write. Everyone else — every identity the roster resolves — is checked.
 */

import type { BoxMembers } from "../box/boxes.ts";

/** Everything the check needs about the installation, injectable. */
export interface MembershipWorld {
  /** The principal behind an identity; undefined for the direct operator and strangers. */
  principalIdOf(identity: string): string | undefined;
  /** Every identity a principal speaks from (links, incarnation-current). */
  identitiesOf(principalId: string): string[];
  /** The active directory person a door's subject resolves to, or undefined. */
  directoryPerson(
    channelId: string,
    vendorSubject: string,
  ): { departmentVendorIds: string[] } | undefined;
  /** A door's department tree as last synced, or undefined when never synced. */
  departmentsOf(
    channelId: string,
  ): Array<{ vendorId: string; name?: string; parentVendorId: string | null }> | undefined;
}

/** The set of vendor ids at or under `root`, in the tree as synced. An unknown root is just itself. */
export function subtreeOf(
  departments: Array<{ vendorId: string; parentVendorId: string | null }>,
  root: string,
): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const department of departments) {
    const parent = department.parentVendorId;
    if (parent === null) continue;
    const children = byParent.get(parent) ?? [];
    children.push(department.vendorId);
    byParent.set(parent, children);
  }
  const subtree = new Set<string>([root]);
  const pending = [root];
  while (pending.length > 0) {
    for (const child of byParent.get(pending.pop()!) ?? []) {
      if (subtree.has(child)) continue;
      subtree.add(child);
      pending.push(child);
    }
  }
  return subtree;
}

/**
 * The check. Fail closed everywhere it can: a stranger is not a member, a
 * department binding with no synced tree admits nobody, a person the
 * directory has deactivated is not in the subtree. Only `everyone` and the
 * operator pass without questions.
 */
export function mayReach(members: BoxMembers, identity: string | undefined, world: MembershipWorld): boolean {
  if (members.kind === "everyone") return true;
  if (identity === undefined) return true; // the direct operator, not a roster person
  const principalId = world.principalIdOf(identity);
  if (principalId === undefined) return false;

  if (members.kind === "listed") {
    return members.principalIds.includes(principalId);
  }
  // department: any of this person's identities on the binding's door, whose
  // directory person stands inside the bound subtree.
  const departments = world.departmentsOf(members.channelId);
  if (departments === undefined) return false; // never synced: nobody, not everyone
  const subtree = subtreeOf(departments, members.departmentVendorId);
  for (const linked of world.identitiesOf(principalId)) {
    const at = linked.indexOf(":");
    if (at <= 0 || linked.slice(0, at) !== members.channelId) continue;
    const person = world.directoryPerson(members.channelId, linked.slice(at + 1));
    if (person === undefined) continue;
    if (person.departmentVendorIds.some(vendorId => subtree.has(vendorId))) return true;
  }
  return false;
}

/**
 * What the box calls its people — the label (docs/22 §5), the refusal
 * sentence, the panel line. Derived from the members, never from doors and
 * never free text; free text may decorate, it may never narrow.
 */
export function audienceOf(members: BoxMembers, world: MembershipWorld): string {
  if (members.kind === "everyone") {
    return "anyone this installation admits";
  }
  if (members.kind === "listed") {
    return members.principalIds.length === 1
      ? "one named member"
      : `${members.principalIds.length} named members`;
  }
  const departments = world.departmentsOf(members.channelId);
  const name = departments?.find(department => department.vendorId === members.departmentVendorId)?.name;
  return name === undefined
    ? `a department of ${members.channelId} (not yet synced — admits nobody)`
    : `${name} (${members.channelId})`;
}
