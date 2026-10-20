/**
 * The ACP session service against the fake engine (docs/81): what the host relies on —
 * events in order with sequence numbers, the engine's own requests answerable, a steer and a
 * cancel landing mid-turn, a crash a definite exit, a restart leaving a loadable record.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpService } from "./acp-service.ts";
import type { AcpEvent } from "../protocol/index.ts";

const ENGINE = fileURLToPath(new URL("./testing/fake-acp-engine.mjs", import.meta.url));
const command = `node ${ENGINE}`;
const base = { nice: 0, scrubbedEnv: { PATH: process.env.PATH ?? "" } as NodeJS.ProcessEnv };

/** Polls until an event the predicate accepts arrives, returning everything seen so far. */
async function until(acp: AcpService, id: string, accept: (event: AcpEvent) => boolean, limitMs = 10_000): Promise<AcpEvent[]> {
  const seen: AcpEvent[] = [];
  const end = Date.now() + limitMs;
  let since = 0;
  while (Date.now() < end) {
    const page = await acp.events({ session_id: id, since, timeout_ms: 500 });
    for (const event of page.events) {
      seen.push(event);
      since = event.seq;
      if (accept(event)) return seen;
    }
    if (!page.running && page.events.length === 0) break;
  }
  throw new Error(`no matching event within ${limitMs}ms; saw ${seen.map(e => e.kind).join(",")}`);
}
const responseTo = (rpcId: number) => (event: AcpEvent) => event.kind === "response" && event.message?.id === rpcId;
const text = (events: AcpEvent[]) =>
  events
    .filter(e => e.kind === "update")
    .map(e => ((e.message?.params as { update?: { content?: { text?: string } } })?.update?.content?.text ?? ""))
    .join("");

test("open, prompt, updates in order, response, close; the record names the engine session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-"));
  const acp = new AcpService(dir);
  try {
    const opened = await acp.open({ session_id: "job-aaaaaaaa", command, cwd: dir, ...base });
    assert.match(opened.engine_session_id, /^fake_/);
    assert.equal(opened.loaded, false);
    assert.ok(existsSync(join(dir, "job-aaaaaaaa.acp.json")), "the record is on disk as soon as the session exists");
    const { rpc_id } = acp.send({ session_id: "job-aaaaaaaa", method: "session/prompt", params: { sessionId: opened.engine_session_id, prompt: [{ type: "text", text: "hello" }] } });
    const events = await until(acp, "job-aaaaaaaa", responseTo(rpc_id!));
    assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1), "sequence numbers are dense from 1");
    assert.equal(text(events), "Done. ");
    assert.equal((events.at(-1)!.message!.result as { stopReason: string }).stopReason, "end_turn");
    const closed = await acp.close({ session_id: "job-aaaaaaaa" });
    assert.equal(closed?.running, false);
    // Read after the close, when the log stream has been ended and flushed.
    await new Promise(resolve => setTimeout(resolve, 50));
    const log = readFileSync(join(dir, "job-aaaaaaaa.log"), "utf8");
    assert.match(log, />> .*"session\/prompt"/, "what we sent is in the log");
    assert.match(log, /"stopReason":"end_turn"/, "and what came back");
    assert.ok(!existsSync(join(dir, "job-aaaaaaaa.acp.json")), "a closed session leaves nothing to load");
    assert.equal(acp.get("job-aaaaaaaa"), undefined);
  } finally {
    acp.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a steer lands mid-turn, a duplicate is a duplicate, and a cancel answers the prompt as cancelled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-"));
  const acp = new AcpService(dir);
  try {
    const { engine_session_id: sid } = await acp.open({ session_id: "job-bbbbbbbb", command, cwd: dir, ...base });
    const steerIdle = acp.send({ session_id: "job-bbbbbbbb", method: "mcode/session/steer", params: { sessionId: sid, text: "x" } });
    const idle = await until(acp, "job-bbbbbbbb", responseTo(steerIdle.rpc_id!));
    assert.match(String((idle.at(-1)!.message!.error as { message: string }).message), /active ACP prompt Turn/);

    const prompt = acp.send({ session_id: "job-bbbbbbbb", method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "SLOW please" }] } });
    await until(acp, "job-bbbbbbbb", e => e.kind === "update");
    const steer = acp.send({ session_id: "job-bbbbbbbb", method: "mcode/session/steer", params: { sessionId: sid, text: "also tests", clientRequestId: "s1" } });
    const steered = await until(acp, "job-bbbbbbbb", responseTo(steer.rpc_id!));
    assert.equal((steered.at(-1)!.message!.result as { mode: string }).mode, "steered");
    const again = acp.send({ session_id: "job-bbbbbbbb", method: "mcode/session/steer", params: { sessionId: sid, text: "also tests", clientRequestId: "s1" } });
    const dup = await until(acp, "job-bbbbbbbb", responseTo(again.rpc_id!));
    assert.equal((dup.at(-1)!.message!.result as { mode: string }).mode, "duplicate");

    acp.send({ session_id: "job-bbbbbbbb", method: "session/cancel", params: { sessionId: sid }, notify: true });
    const cancelled = await until(acp, "job-bbbbbbbb", responseTo(prompt.rpc_id!));
    assert.equal((cancelled.at(-1)!.message!.result as { stopReason: string }).stopReason, "cancelled");
    assert.equal(acp.get("job-bbbbbbbb")?.running, true, "the process stays up after a cancel");
  } finally {
    await acp.close({ session_id: "job-bbbbbbbb" });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the engine's own request arrives as an event and is answered by id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-"));
  const acp = new AcpService(dir);
  try {
    const { engine_session_id: sid } = await acp.open({ session_id: "job-cccccccc", command, cwd: dir, ...base });
    const prompt = acp.send({ session_id: "job-cccccccc", method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "ASK first" }] } });
    const asked = await until(acp, "job-cccccccc", e => e.kind === "request");
    const request = asked.at(-1)!.message!;
    assert.equal(request.method, "session/request_permission");
    const options = (request.params as { options: { optionId: string }[] }).options.map(o => o.optionId);
    assert.deepEqual(options, ["allow-once", "allow-always", "deny"]);
    acp.reply({ session_id: "job-cccccccc", rpc_id: request.id as number, result: { outcome: { outcome: "selected", optionId: "allow-once" } } });
    const done = await until(acp, "job-cccccccc", responseTo(prompt.rpc_id!));
    assert.match(text(done), /ran it\./);
  } finally {
    await acp.close({ session_id: "job-cccccccc" });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a crash mid-turn is an exit event with the code, and the pending prompt gets an error response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-"));
  const acp = new AcpService(dir);
  try {
    const { engine_session_id: sid } = await acp.open({ session_id: "job-dddddddd", command, cwd: dir, ...base });
    acp.send({ session_id: "job-dddddddd", method: "session/prompt", params: { sessionId: sid, prompt: [{ type: "text", text: "CRASH now" }] } });
    const events = await until(acp, "job-dddddddd", e => e.kind === "exit");
    assert.equal(events.at(-1)!.exit_code, 3);
    const after = await acp.events({ session_id: "job-dddddddd", since: 0, timeout_ms: 10 });
    assert.equal(after.running, false);
    assert.equal(after.exit_code, 3);
    assert.throws(() => acp.send({ session_id: "job-dddddddd", method: "session/prompt" }), /not running/);
  } finally {
    await acp.close({ session_id: "job-dddddddd" });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("after a restart the record is listed detached, and opening the same id loads the engine session — in the same cwd only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-"));
  const state = join(dir, "fake-state.json");
  const env = { FAKE_ACP_STATE: state };
  const first = new AcpService(dir);
  const opened = await first.open({ session_id: "job-eeeeeeee", command, cwd: dir, env, ...base });
  const prompt = first.send({ session_id: "job-eeeeeeee", method: "session/prompt", params: { sessionId: opened.engine_session_id, prompt: [{ type: "text", text: "remember me" }] } });
  await until(first, "job-eeeeeeee", responseTo(prompt.rpc_id!));
  // boxd goes away without closing: the process is killed, the record stays.
  first.shutdown();
  await new Promise(resolve => setTimeout(resolve, 200));

  const second = new AcpService(dir);
  try {
    const listed = second.list().find(s => s.session_id === "job-eeeeeeee");
    assert.equal(listed?.detached, true);
    assert.equal(listed?.engine_session_id, opened.engine_session_id);
    assert.equal(listed?.cwd, dir);
    mkdirSync(join(dir, "elsewhere"));
    await assert.rejects(
      second.open({ session_id: "job-eeeeeeee", command, cwd: join(dir, "elsewhere"), env, engine_session_id: opened.engine_session_id, ...base }),
      /does not match the persisted session workspace/
    );
    assert.equal(second.get("job-eeeeeeee"), undefined, "a failed open leaves no record to try again");
    const loaded = await second.open({ session_id: "job-eeeeeeee", command, cwd: dir, env, engine_session_id: opened.engine_session_id, ...base });
    assert.equal(loaded.loaded, true);
    const replay = await second.events({ session_id: "job-eeeeeeee", since: 0, timeout_ms: 10 });
    assert.ok(replay.events.some(e => e.kind === "update" && JSON.stringify(e.message).includes("remember me")), "history replayed on load");
    await assert.rejects(
      second.open({ session_id: "job-eeeeeeee", command, cwd: dir, env, engine_session_id: "fake_nothing", ...base }),
      /already open/
    );
  } finally {
    await second.close({ session_id: "job-eeeeeeee" });
    rmSync(dir, { recursive: true, force: true });
  }
});
