/**
 * What a box is, said in the words a person reads.
 *
 * docs/18 v4: a box declares its class, and what it promises follows from that. A
 * **private** box belongs to one person and is trusted with their data. A **shared** box
 * belongs to a group, a tenant, or everyone; it promises nothing about privacy between
 * the people who can reach it, and it says so where they work.
 *
 * Two decisions are baked in here and are the whole point of the module:
 *
 * 1. **Absent means shared.** A box with no record is not "unclassified" and is not
 *    optimistically private. Claiming privacy without the machinery that would make it
 *    private is the exact lie this design exists to remove, so the default is the class
 *    that promises nothing. A box becomes private only when somebody says so.
 *
 * 2. **The notice is a label, not a warning.** It renders permanently wherever the work
 *    happens, rather than firing at the moment a password is typed. A guard that fires
 *    only when we happen to be looking teaches people to rely on it and then does not
 *    fire; a label is true every time somebody looks at it (docs/18 §3.1). Nothing here
 *    refuses anything — it cannot, and the attempt would be worse than the absence.
 */

import type { AgentboxConfig, BoxAccess } from "../config.ts";

export type { BoxAccess };

export interface BoxClass {
  access: BoxAccess;
  /** Who "shared" means, when somebody said. Free text, for the label. */
  group?: string;
  /** Two words for a header or a list row. */
  badge: string;
  /** The sentence, for wherever there is room for one. Empty for a private box. */
  notice: string;
}

const PRIVATE: BoxClass = {
  access: "private",
  badge: "私有箱子",
  // A private box makes a promise instead of a disclaimer, and the promise is not a
  // guarantee of secrecy from the software: docs/18 §7 is the long form.
  notice: "",
};

/**
 * The class of the box named `name`, and how to say it.
 *
 * `name` is the provisioner's `boxName` — the container name for a box we run, the URL
 * for one we attached to.
 */
export function classifyBox(name: string, config: Pick<AgentboxConfig, "boxes">): BoxClass {
  const record = config.boxes?.[name];
  if (record?.access === "private") return PRIVATE;
  const group = record?.group?.trim();
  return {
    access: "shared",
    ...(group ? { group } : {}),
    badge: "共享箱子",
    notice: sharedNotice(group),
  };
}

/**
 * The words themselves.
 *
 * Concrete rather than abstract — screens, files, command history, backups — because
 * "this box is shared" reads as an administrative detail, while "logging in here logs
 * them in too" is the consequence the person is actually deciding about.
 */
export function sharedNotice(group?: string): string {
  const who = group ? `${group} 里的人` : "所有能打开它的人";
  return (
    `这是一台共享的箱子。${who}都能看它的屏幕、读它的文件和命令历史,备份也会带走你在这里登录过的东西。` +
    "在这里登录任何账号,等于替他们一起登录。"
  );
}
