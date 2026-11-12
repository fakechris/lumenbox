import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore, type Task } from "./tasks.ts";
import { archivable, archiveEnded, restoreArchived } from "./task-archive.ts";
import { taskArchiveRoute } from "../web/task-archive-routes.ts";

const audience = (task: Task) => (task.requester === "agent-a" ? "internal" : "user");

function board(home: string) {
  const store = new TaskStore(join(home, "tasks.jsonl"));
  const make = (title: string, requester: string, extra: Partial<Parameters<TaskStore["create"]>[0]> = {}) => store.create({ title, requester, assigneeId: "agent-b", ...extra })!;
  const probe = make("probe that ended", "agent-a"), needed = make("check a live card waits on", "agent-a");
  const running = make("audit still running", "agent-a", { blockedBy: [needed.id] }), asked = make("what a person asked", "web:chris");
  for (const task of [probe, needed, asked]) store.update(task.id, { status: "dropped" }, task.requester);
  return { store, probe, needed, running, asked };
}

test("ended internal records leave the board for the month's archive; a person's, a live one and what a live one waits on stay", () => {
  const home = mkdtempSync(join(tmpdir(), "task-archive-"));
  try {
    const { store, probe, needed, running, asked } = board(home), now = new Date("2026-11-12T00:00:00Z");
    assert.deepEqual([archivable(store.list(), audience).take.map(task => task.id), archivable(store.list(), audience).live], [[probe.id], 1]);
    const done = archiveEnded(store, audience, now);
    assert.equal(done.archived, 1);
    assert.equal(done.file, join(home, "tasks.2026-11.jsonl"));
    assert.equal(JSON.parse(readFileSync(done.file!, "utf8").trim()).task.title, "probe that ended", "the record is in the archive, whole");
    const reopened = new TaskStore(join(home, "tasks.jsonl"));
    assert.deepEqual(reopened.list().map(task => task.id).sort(), [needed.id, running.id, asked.id].sort(), "and a restart reads a board without it");
    assert.deepEqual(archiveEnded(reopened, audience, now), { archived: 0 }, "nothing left to take is not an error");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("archived records come back as they were, and one already on the board is not overwritten", () => {
  const home = mkdtempSync(join(tmpdir(), "task-archive-"));
  try {
    const { store, probe } = board(home), now = new Date("2026-11-12T00:00:00Z");
    const before = store.get(probe.id)!;
    archiveEnded(store, audience, now);
    assert.equal(restoreArchived(store, now).restored, 1);
    assert.deepEqual(new TaskStore(join(home, "tasks.jsonl")).get(probe.id), before);
    assert.equal(restoreArchived(store, now).restored, 0, "a second restore finds it there");
    assert.equal(existsSync(join(home, "tasks.2026-11.jsonl")), true, "the archive is kept: it only grows");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("from the page: anybody counts, only an admin moves records, and the file is named, not located", async () => {
  const home = mkdtempSync(join(tmpdir(), "task-archive-"));
  try {
    const { store } = board(home);
    let admin = false, body: Record<string, unknown> = { action: "archive" };
    const call = (route: string) => taskArchiveRoute(route, { tasks: store, audience, readJson: async () => body, refusedAdmin: () => !admin });
    assert.equal(await call("GET /api/tasks/list"), undefined, "other routes are not this module's");
    assert.deepEqual((await call("GET /api/tasks/archive"))!.body, { ended: 1, live: 1 });
    assert.deepEqual(await call("POST /api/tasks/archive"), { status: 0, body: null }, "a non-admin is refused");
    assert.equal(store.list().length, 4, "and nothing moved");
    admin = true; body = { action: "delete" };
    assert.equal((await call("POST /api/tasks/archive"))!.status, 400);
    body = { action: "archive" };
    const done = (await call("POST /api/tasks/archive"))!.body as { archived: number; file: string; ended: number };
    assert.deepEqual([done.archived, done.ended], [1, 0]);
    assert.match(done.file, /^tasks\.\d{4}-\d{2}\.jsonl$/);
    body = { action: "restore" };
    assert.equal(((await call("POST /api/tasks/archive"))!.body as { restored: number }).restored, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
