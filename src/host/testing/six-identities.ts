/**
 * A de-identified copy of the roster shape INV-1698 was written for: one desktop installation whose
 * `principals.json` has no `installation` field and six people who are one person — an admin from
 * one Feishu app (who redeemed the first-admin bootstrap), three drivers from a second Feishu app,
 * one from DingTalk, one from a browser — plus a record naming them in every store that holds a
 * person's id. Every id, name and value is invented; only the structure is the real one.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MergePaths } from "../self-merge.ts";

export const SIX = {
  admin: "feishu:ou_fake_admin_01",
  work1: "feishu-work:ou_fake_work_01",
  work2: "feishu-work:ou_fake_work_02",
  work3: "feishu-work:ou_fake_work_03",
  dingtalk: "dingtalk:fake_staff_01",
  web: "web:fake_browser_01",
} as const;

export const SIX_IDS: readonly string[] = Object.values(SIX);

export function sixPaths(home: string): MergePaths {
  return {
    home, roster: join(home, "principals.json"), agents: join(home, "agents"), tasks: join(home, "tasks.jsonl"), usage: join(home, "usage.jsonl"),
    vault: join(home, "vault.json"), turns: join(home, "turns.jsonl"), inbox: join(home, "inbox.jsonl"), config: join(home, "config.json"), rules: join(home, "rules"),
  };
}

const jsonl = (rows: unknown[]) => `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;

/**
 * Writes the six-person installation into `home`. `ledgers: false` leaves out the turn ledger and the
 * inbox, whose half-written turns a starting server would try to resume; `boxes: false` leaves the
 * box list to the registry, which writes its own on first start.
 */
export function writeSixIdentities(home: string, options: { ledgers?: boolean; boxes?: boolean } = {}): void {
  const write = (path: string, content: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content, { mode: 0o600 }); };
  const person = (id: string, name: string, role: string) => ({ id, name, role, identities: [{ identity: id, incarnation: 1 }], anchors: [] });
  write(join(home, "principals.json"), `${JSON.stringify({
    bootstrap: { disabled: true, redeemedAt: "2026-09-20T08:00:00.000Z", redeemedBy: SIX.admin },
    principals: [
      person(SIX.admin, "Sam", "admin"),
      person(SIX.work1, "Sam", "driver"),
      person(SIX.work2, "sam.w", "driver"),
      person(SIX.work3, "Sam W", "driver"),
      person(SIX.dingtalk, "Sam (DingTalk)", "driver"),
      person(SIX.web, "Sam", "driver"),
    ],
  }, null, 2)}\n`);
  write(join(home, "mcp-tokens.json"), `${JSON.stringify({ tokens: [
    { hash: "a".repeat(64), principalId: SIX.admin, label: "editor", createdAt: "2026-10-01T00:00:00.000Z" },
    { hash: "b".repeat(64), principalId: SIX.work2, label: "laptop", createdAt: "2026-10-02T00:00:00.000Z" },
  ] }, null, 2)}\n`);
  write(join(home, "watchdog", "install.json"), `${JSON.stringify({ label: "watchdog", url: "http://127.0.0.1:1", principalId: SIX.admin, createdAt: "2026-10-03T00:00:00.000Z", plist: "", installedAt: "2026-10-03T00:00:00.000Z" }, null, 2)}\n`);
  const task = (id: string, requester: string, by: string) => ({ kind: "task", task: { id, title: `fake task ${id}`, status: "open", requester, createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z", history: [{ at: "2026-10-04T00:00:00.000Z", status: "open", by }] } });
  write(join(home, "tasks.jsonl"), jsonl([{ kind: "counter", value: 3 }, task("t1", SIX.work1, SIX.work1), task("t1", SIX.work1, SIX.work3), task("t2", SIX.dingtalk, "ada"), task("t3", "web", "ada")]));
  const spend = (principal: string | undefined, at: string) => ({ seq: 1, at, agentId: "ada", ...(principal !== undefined ? { principal } : {}), provider: "fake", model: "fake-model", round: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 });
  write(join(home, "usage.jsonl"), jsonl([spend(SIX.admin, "2026-10-05T09:00:00.000Z"), spend(SIX.dingtalk, "2026-10-06T09:00:00.000Z"), spend(undefined, "2026-10-06T10:00:00.000Z")]));
  write(join(home, "agents", "ada", "memory.jsonl"), jsonl([{ at: "2026-10-07T00:00:00.000Z", kind: "fact", text: "prefers short answers", source: "RememberFact", about: SIX.work3 }, { at: "2026-10-07T00:00:00.000Z", kind: "fact", text: "the team builds a box", source: "RememberFact" }]));
  write(join(home, "agents", "shared-memory", "ada.jsonl"), jsonl([{ at: "2026-10-07T00:00:00.000Z", kind: "fact", text: "works late", source: "RememberFact", about: SIX.web, box: "default" }]));
  write(join(home, "people.jsonl"), jsonl([{ kind: "entry", principal: SIX.dingtalk, entry: { id: "p1", field: "preferences", text: "replies in Chinese", at: "2026-10-08T00:00:00.000Z", source: "person" } }]));
  if (options.boxes !== false) {
    write(join(home, "agents", "boxes.json"), `${JSON.stringify([{ id: "box_fake_default", name: "default", kind: "docker", displayFloor: 1, workDir: "/home/box/work", members: [SIX.admin, SIX.work1, "someone-else"], createdAt: "2026-09-20T08:00:00.000Z" }], null, 2)}\n`);
  }
  write(join(home, "vault.json"), `${JSON.stringify({ secrets: [{ id: "fake-api", description: "an invented secret", value: "fake-not-a-secret", grants: [{ holder: `principal:${SIX.work2}` }, { holder: "agent:ada" }] }] }, null, 2)}\n`);
  write(join(home, "session-epochs.json"), `${JSON.stringify({ [SIX.web]: 1 }, null, 2)}\n`);
  write(join(home, "config.json"), `${JSON.stringify({ personBoxQuotas: { [SIX.work1]: 2, [SIX.work2]: 3 } }, null, 2)}\n`);
  write(join(home, "rules", "sams-deploys.md"), "---\nname: Sam's deploys\neffect: allow\ntools: RunOnHost\nprincipal: feishu-work:ou_fake_work_01, Sam W\n---\nSam may deploy the staging site without asking.\n");
  write(join(home, "messages.jsonl"), jsonl([
    { schema: "lumenbox.message/v1", id: "m1", channel: "feishu", chatKey: "feishu:oc_fake", identity: SIX.admin, senderLabel: "Sam", conversationKey: "feishu:oc_fake", receivedAt: "2026-10-09T08:00:00.000Z", text: "hello", textChars: 5 },
    { schema: "lumenbox.message/v1", id: "m2", channel: "feishu-work", chatKey: "feishu-work:oc_fake", identity: SIX.work2, senderLabel: "sam.w", conversationKey: "feishu-work:oc_fake", receivedAt: "2026-10-10T08:00:00.000Z", text: "hi", textChars: 2 },
  ]));
  if (options.ledgers !== false) {
    write(join(home, "turns.jsonl"), jsonl([{ id: "turn1", event: "begin", agentId: "ada", at: "2026-10-11T00:00:00.000Z", principalId: SIX.work1 }]));
    write(join(home, "inbox.jsonl"), jsonl([{ kind: "admitted", id: "i1", agentId: "ada", message: { text: "do it", principalId: SIX.dingtalk } }]));
  }
}
