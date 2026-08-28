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
  /**
   * Whether anything actually enforces this class.
   *
   * False for a box declared `private` while docs/18 steps 4-8 are unbuilt. Surfaces
   * key their wording on this and not on `access`, because what the product may claim
   * follows from the machinery, not from the config file.
   */
  enforced: boolean;
  /** Two words for a header or a list row. */
  badge: string;
  /** The sentence, for wherever there is room for one. Empty only when it is earned. */
  notice: string;
}

/**
 * Whether the machinery that makes a private box private exists yet.
 *
 * It does not. docs/18 steps 4-8 — one session resolver, agents bound to a box, the
 * takeover state, revoke-and-wipe — are all unbuilt, and without them `private` is a
 * *declaration of intent*, not a property of anything: `callerOf` still treats an
 * unauthenticated direct caller as owner, the UI token is one file for the whole
 * installation, and every agent can reach every box the process can.
 *
 * This is one constant rather than a check in each surface because the failure it
 * prevents is asymmetric and was live for a few hours: setting `private` made the
 * product **quieter and more confident** — the shared sentence disappeared and a tooltip
 * said "only you can open this box" — so the unsafe value was the one that removed the
 * warnings. A default is only honest if the other value cannot lie, and this is where
 * that is arranged. Flip it in step 8, in one place, and delete this paragraph.
 */
export const PRIVATE_IS_ENFORCED = false;

const PRIVATE: BoxClass = {
  access: "private",
  enforced: true,
  badge: "私有箱子",
  // An enforced private box makes a promise instead of a disclaimer, and the promise is
  // not a guarantee of secrecy from the software: docs/18 §7 is the long form.
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
  const group = record?.group?.trim();
  if (record?.access === "private") {
    if (PRIVATE_IS_ENFORCED) return PRIVATE;
    // Not silently downgraded to `shared`: the operator asked for something, and telling
    // them it is not in effect is more use than pretending they never asked. The class
    // they get is the true one — nothing here is private — said in their own words.
    return {
      access: "private",
      enforced: false,
      badge: "私有箱子(未生效)",
      notice: unenforcedPrivateNotice(),
    };
  }
  return {
    access: "shared",
    ...(group ? { group } : {}),
    enforced: true,
    badge: "共享箱子",
    notice: sharedNotice(group),
  };
}

/**
 * What a box marked private actually is today.
 *
 * Deliberately at least as loud as the shared notice, and it leads with the correction
 * rather than the intent: somebody reading this has been told elsewhere that the box is
 * private, and the first thing they need is that it is not.
 */
export function unenforcedPrivateNotice(): string {
  return (
    "这台箱子被标成了私有,但**私有还没有生效**:能打开它的人都能看它的屏幕、读它的文件和命令历史," +
    "备份也会带走你在这里登录过的东西。在功能补齐之前,请当成共享箱子用。"
  );
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
