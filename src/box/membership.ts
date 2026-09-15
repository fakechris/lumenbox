/**
 * Who a box is for (INV-538, docs/22 §5).
 *
 * `BoxEntry.members` has existed since boxes became a list, and has been `"everyone"` in
 * every installation ever run, checked nowhere — the field said what the model intended
 * and the code admitted anybody. That was honest while there was one person; it stops
 * being honest the moment a second identity can sign in, which is now.
 *
 * The rule is deliberately the whole of it:
 *
 * - **`"everyone"` means everyone this installation admits.** Unchanged behaviour, and the
 *   default, so a personal installation notices nothing.
 * - **A list means those principals, and nobody else.** Not "those plus admins": an admin
 *   can add themselves, in writing, in a file with an audit line — which is a different
 *   act from quietly being in every room.
 * - **No principal means the operator**, holding the installation's own credential: the
 *   CLI, a script, a single-person install. They are not a member of anything because
 *   they are not a person the roster knows; refusing them would lock the machine out of
 *   itself.
 *
 * Authority lives on the box and nowhere else (docs/22 §0): an agent has no members of
 * its own, so this function takes a box and answers for every agent in it identically.
 */

import type { BoxEntry } from "./boxes.ts";

export function mayEnterBox(box: Pick<BoxEntry, "members">, principalId: string | undefined): boolean {
  if (principalId === undefined) return true;
  if (box.members === "everyone") return true;
  return box.members.includes(principalId);
}

/**
 * The permanent label, derived from the members and not from free text (docs/22 §5).
 *
 * A door's vendor-side population can never be the source: which groups a Feishu app is in
 * changes with no event here. `nameOf` turns a principal id into the name a person reads.
 */
export function membersLabel(box: Pick<BoxEntry, "members">, nameOf: (principalId: string) => string): string {
  if (box.members === "everyone") return "共享箱子：这个安装放进来的任何人，从这个箱子的任何一道门或网页";
  if (box.members.length === 0) return "无人箱子：成员集合是空的，只有安装自身的凭证进得来";
  if (box.members.length === 1) return `${nameOf(box.members[0]!)} 的箱子：只有他/她进得来`;
  return `${box.members.length} 人的箱子：${box.members.map(nameOf).join("、")}`;
}

/** What somebody who is not a member is told — by name, because a blank refusal is a support ticket. */
export function refusalToEnter(boxName: string, principalName: string): string {
  return `${boxName} is not a box ${principalName} is in. An admin can add you to it; nothing here is hidden from its members, and nothing is shown to anyone else.`;
}
