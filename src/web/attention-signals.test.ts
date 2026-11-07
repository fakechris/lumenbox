/** The dock badge and the two notification kinds (INV-1626): needs-you when waiting begins, done when a turn ends with news; never focused; throttled. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

type Org = { id: string; name: string; unread?: number; needsYou?: number; unknown?: boolean };
type OrgNotice = { kind: string; installationId: string; name: string; count: number; silent: boolean };
const { badgeCount, dockCount, notificationsDue, organisationNotice, organisationNoticesDue, THROTTLE_MS } = createRequire(import.meta.url)("../../electron/attention-signals.cjs") as {
  badgeCount: (agents: unknown[]) => number;
  dockCount: (agents: unknown[], organisations: Org[]) => number;
  notificationsDue: (previous: unknown[], current: unknown[], focused: boolean, now: number, sent: Map<string, number>) => { kind: string; agentId: string; title: string; body: string; silent: boolean }[];
  organisationNoticesDue: (known: Map<string, number>, organisations: Org[], focused: boolean, now: number, sent: Map<string, number>) => OrgNotice[];
  organisationNotice: (due: OrgNotice, words: Record<string, string>) => { title: string; body: string };
  THROTTLE_MS: number;
};

const agent = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), running: false, facts: { unreadCount: 0 }, ...over });

test("the badge is the sum of unread over the agents and the joined organisations; missing facts and unknown counts add nothing (INV-1709)", () => {
  const agents = [agent("ada", { facts: { unreadCount: 2 } }), agent("vic", { facts: { unreadCount: 3.7 } }), { id: "x", name: "X" }];
  assert.equal(badgeCount(agents), 5);
  assert.equal(badgeCount([]), 0);
  const orgs: Org[] = [{ id: "org-a", name: "Acme", unread: 4, needsYou: 1 }, { id: "org-b", name: "Beta", unknown: true }, { id: "org-c", name: "Zeta", unread: 0, needsYou: 0 }];
  assert.equal(dockCount(agents, orgs), 9, "personal 5 + Acme 4; Beta could not be read, so it is not guessed");
  assert.equal(dockCount([], orgs), 4, "an organisation node runs no personal installation; its organisations still count");
  assert.equal(dockCount(agents, []), 5);
});

test("an organisation's needs-you is said when it goes from none to some, by name and count only; nothing while focused; throttled per organisation (INV-1709)", async () => {
  const known = new Map<string, number>();
  const sent = new Map<string, number>();
  const t0 = 2_000_000;
  const at = (needsYou: number, over: Partial<Org> = {}): Org[] => [{ id: "org-a", name: "Acme", unread: 0, needsYou, ...over }];
  assert.deepEqual(organisationNoticesDue(known, at(0), false, t0, sent), [], "nothing waiting is not news");
  assert.deepEqual(organisationNoticesDue(known, at(2), true, t0 + 1, sent), [], "focused: the column already shows it");
  assert.deepEqual(organisationNoticesDue(known, at(3), false, t0 + 2, sent), [], "still waiting (seen while focused) is not news");
  assert.deepEqual(organisationNoticesDue(known, at(0), false, t0 + 3, sent), []);
  const due = organisationNoticesDue(known, at(2), false, t0 + 4, sent);
  assert.deepEqual(due, [{ kind: "organisation-needs-you", installationId: "org-a", name: "Acme", count: 2, silent: false }]);
  assert.deepEqual(organisationNoticesDue(known, at(0, { unknown: true, needsYou: undefined }), false, t0 + 5, sent), [], "an unread count is unknown, not zero");
  assert.deepEqual(organisationNoticesDue(known, at(2), false, t0 + THROTTLE_MS * 2, sent), [], "back on the network with the same items is not news");
  organisationNoticesDue(known, at(0), false, t0 + 6, sent);
  assert.deepEqual(organisationNoticesDue(known, at(1), false, t0 + 7, sent), [], "inside five seconds of the last one, not said twice");
  organisationNoticesDue(known, at(0), false, t0 + 8, sent);
  assert.equal(organisationNoticesDue(known, at(1), false, t0 + 4 + THROTTLE_MS + 1, sent).length, 1, "past the window it may be said again");
  const fresh = new Map<string, number>();
  assert.equal(organisationNoticesDue(fresh, at(5), false, t0, new Map()).length, 1, "what is waiting when the app starts is said once");
  organisationNoticesDue(fresh, [], false, t0 + 1, new Map());
  assert.equal(fresh.size, 0, "a disconnected organisation is forgotten");
  const agentSent = new Map<string, number>();
  notificationsDue([], [agent("org-a", { facts: { unreadCount: 0, awaiting: { reason: "r" } } })], false, t0, agentSent);
  assert.equal(organisationNoticesDue(new Map(), at(1), false, t0, agentSent).length, 1, "an agent's throttle and an organisation's are separate, even with the same id");

  const { shellWords } = await import("./shell-words-print.ts");
  const zh = shellWords("zh-CN,en-US", undefined);
  const en = shellWords("zh-CN,en-US", "en");
  assert.deepEqual([zh.locale, en.locale], ["zh", "en"], "the person's choice on the personal page wins over the system's languages");
  assert.deepEqual(organisationNotice(due[0]!, en.words), { title: "Acme has 2 waiting for you", body: "Open LumenBox to see them in Acme." });
  assert.deepEqual(organisationNotice(due[0]!, zh.words), { title: "Acme 有 2 件需要你", body: "打开 LumenBox，在 Acme 里查看。" });
});

test("needs-you fires once when waiting begins, with the reason; done fires when a turn ends with new unread; nothing while focused; throttled per agent and kind", () => {
  const sent = new Map<string, number>();
  const t0 = 1_000_000;
  const quiet = [agent("ada"), agent("vic", { running: true })];
  const waiting = [agent("ada", { facts: { unreadCount: 0, awaiting: { kind: "approval", reason: "bash — rm -rf .scratch", since: "x" } } }), agent("vic", { running: false, facts: { unreadCount: 1 } })];
  assert.deepEqual(notificationsDue(quiet, waiting, true, t0, sent), [], "focused: the person is looking");
  const due = notificationsDue(quiet, waiting, false, t0, sent);
  assert.deepEqual(due.map(n => [n.kind, n.agentId, n.silent]), [["needs-you", "ada", false], ["done", "vic", true]]);
  assert.equal(due[0]!.title, "Ada needs you");
  assert.equal(due[0]!.body, "bash — rm -rf .scratch");
  assert.deepEqual(notificationsDue(quiet, waiting, false, t0 + 1_000, sent), [], "the same change again inside the window is not sent twice");
  assert.equal(notificationsDue(quiet, waiting, false, t0 + THROTTLE_MS + 1, sent).length, 2, "past the window it may be said again");
  assert.deepEqual(notificationsDue(waiting, waiting, false, t0 + 20_000, sent), [], "still waiting is not news");
  const endedQuietly = [agent("ada"), agent("vic", { running: false, facts: { unreadCount: 0 } })];
  assert.deepEqual(notificationsDue(quiet, endedQuietly, false, t0 + 40_000, sent), [], "a turn that ended without saying anything is not done-news");
});

test("one badge from both inputs, and the organisation's notice in the person's chosen language, through the shell's own words reader (INV-1709)", async () => {
  const { dockSignals, shellWordsReader } = createRequire(import.meta.url)("../../electron/dock-signals.cjs") as {
    dockSignals: (o: object) => { agentsRead(a: unknown[]): void; organisationsRead(o: Org[]): Promise<void> };
    shellWordsReader: (o: object) => () => Promise<Record<string, string>>;
  };
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  let choice = "en";
  const words = shellWordsReader({ execPath: process.execPath, repo, languages: () => ["zh-CN"], choice: () => choice });
  const badges: number[] = [];
  const notices: [string, string, unknown][] = [];
  let focused = false;
  const signals = dockSignals({ setBadge: (n: number) => badges.push(n), notify: (title: string, body: string, options: unknown) => notices.push([title, body, options]), focused: () => focused, words });
  signals.agentsRead([agent("ada", { facts: { unreadCount: 2 } })]);
  await signals.organisationsRead([{ id: "org-a", name: "Acme", unread: 3, needsYou: 1 }, { id: "org-b", name: "Beta", unknown: true }]);
  assert.deepEqual(badges, [2, 5]);
  assert.deepEqual(notices, [["Acme has 1 waiting for you", "Open LumenBox to see them in Acme.", { installationId: "org-a" }]], "the notice carries the installation to switch to, and no token");
  choice = "zh";
  await signals.organisationsRead([{ id: "org-a", name: "Acme", unread: 3, needsYou: 0 }, { id: "org-b", name: "Beta", unread: 0, needsYou: 4 }]);
  assert.deepEqual(notices[1]!.slice(0, 2), ["Beta 有 4 件需要你", "打开 LumenBox，在 Beta 里查看。"]);
  focused = true;
  await signals.organisationsRead([{ id: "org-a", name: "Acme", unread: 9, needsYou: 2 }]);
  assert.equal(notices.length, 2, "focused: no notice");
  assert.equal(badges.at(-1), 11, "but the badge still moves");
});
