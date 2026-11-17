/** What a box update waits for (INV-1551): only work that is really running on a box that answers. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxUpdateService } from "./box-update-routes.ts";

const service = (turns: number) => new BoxUpdateService({ activeTurns: () => turns, reconnect: async () => {}, broadcast: () => {}, log: () => {} });
const busyOf = (s: BoxUpdateService, manager: unknown) => (s as unknown as { busy(m: unknown): Promise<string[]> }).busy(manager);
const box = (health: () => Promise<unknown>, jobs: () => Promise<unknown>) => ({ connect: async () => ({ health, jobs }) });

test("a stopped box, or one that does not answer, has nothing to interrupt, whatever turns are spinning on it", async () => {
  assert.deepEqual(await busyOf(service(4), { connect: async () => { throw new Error("Box agentbox-box is not running (state: exited)."); } }), []);
  assert.deepEqual(await busyOf(service(4), box(async () => { throw new Error("fetch failed"); }, async () => ({ jobs: [] }))), []);
});

test("a box that answers: its turns and running jobs are what an update waits for; unreadable jobs refuse", async () => {
  const running = box(async () => ({ ok: true }), async () => ({ jobs: [{ job_id: "j1", command: "npm test", running: true }, { job_id: "j2", command: "ls", running: false }] }));
  assert.deepEqual(await busyOf(service(2), running), ["2 turn(s) in progress", "job j1: npm test"]);
  await assert.rejects(busyOf(service(0), box(async () => ({ ok: true }), async () => { throw new Error("jobs timed out"); })), /jobs timed out/);
});

test("an update backs the volumes up only when asked: one default, sent to both pages and applied when a request does not say (INV-1906)", async () => {
  const { boxUpdateRoute } = await import("./box-update-routes.ts");
  const { BACKUP_BY_DEFAULT } = await import("../box/box-update.ts");
  assert.equal(BACKUP_BY_DEFAULT, false, "an update leaves the volumes alone; copying them every time costs minutes and a gigabyte");
  assert.equal(service(0).view().backupByDefault, false, "the pages read the default from the server");
  const asked: { backup: boolean }[] = [];
  const fake = { view: () => ({ checkedAt: 1 }), check: async () => {}, start: (options: { backup: boolean }) => { asked.push(options); return true; } } as unknown as BoxUpdateService;
  for (const body of [{}, { backup: true }, { backup: false }]) await boxUpdateRoute("POST /api/box/image/update", fake, { readJson: async () => body, refusedAdmin: () => false });
  assert.deepEqual(asked.map(options => options.backup), [false, true, false]);
});
