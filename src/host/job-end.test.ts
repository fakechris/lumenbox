/** What a job's end is worth (INV-1613): the three policies, the wait-only commands, the note for recorded ends. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isWaitOnly, onEndSchema, parseOnEnd, recordedEndsNote, wakesFor } from "./job-end.ts";

test("wake wakes always; wake_on_failure on a bad exit, a kill, an interruption or a named line; record never", () => {
  const ok = { exit_code: 0, tail: "done" };
  const bad = { exit_code: 1, tail: "3 failed" };
  assert.equal(wakesFor("wake", undefined, ok), true);
  assert.equal(wakesFor("record", undefined, bad), false);
  assert.equal(wakesFor("wake_on_failure", undefined, ok), false);
  assert.equal(wakesFor("wake_on_failure", undefined, bad), true);
  assert.equal(wakesFor("wake_on_failure", undefined, { exit_code: 0, killed: true, tail: "" }), true);
  assert.equal(wakesFor("wake_on_failure", undefined, { interrupted: true, tail: "" }), true);
  assert.equal(wakesFor("wake_on_failure", "READY", { exit_code: 0, tail: "server READY on 8080" }), true);
  assert.equal(wakesFor("wake_on_failure", "READY", { exit_code: 0, tail: "still warming" }), false);
  assert.equal(wakesFor("wake_on_failure", "", ok), false);
});

test("a command that only waits is recognised; one that waits and then works is not", () => {
  for (const command of ["sleep 30", "sleep 2.5", "tail -f /var/log/app.log", "tail -n 50 -f out.log", "sleep 10; sleep 10", "sleep 5 && tail -F x.log", "wait", "wait 1234", "inotifywait -e close_write ./out", "timeout 60 tail -f build.log", "sleep 1\nsleep 2\n"]) {
    assert.equal(isWaitOnly(command), true, command);
  }
  for (const command of ["sleep 20; curl -s http://host/api/tasks", "npm test", "tail -n 20 out.log", "sleep 5; echo done", "", "   ", "sleep", "sleepy 3"]) {
    assert.equal(isWaitOnly(command), false, JSON.stringify(command));
  }
});

test("on_end parses only its three values; the schema names them and points at Jobs wait", () => {
  assert.equal(parseOnEnd("wake"), "wake");
  assert.equal(parseOnEnd("wake_on_failure"), "wake_on_failure");
  assert.equal(parseOnEnd("record"), "record");
  assert.equal(parseOnEnd("always"), undefined);
  assert.equal(parseOnEnd(undefined), undefined);
  assert.equal(parseOnEnd(1), undefined);
  const schema = onEndSchema() as { on_end: { enum: string[]; description: string }; wake_when: { type: string } };
  assert.deepEqual(schema.on_end.enum, ["wake", "wake_on_failure", "record"]);
  assert.match(schema.on_end.description, /Jobs wait/);
  assert.equal(schema.wake_when.type, "string");
});

test("recorded ends become one host note, a line per job; none means no note", () => {
  assert.equal(recordedEndsNote([]), undefined);
  const one = recordedEndsNote([{ jobId: "job-1", command: "sleep 20;\n  curl -s http://x", exit_code: 0, log_path: "/j/1.log" }]);
  assert.match(one!, /^\[host\] Since your last turn, a command you started ended; nothing woke you for it:\n- job-1 \(exit 0\): sleep 20; curl -s http:\/\/x — log \/j\/1.log$/);
  const two = recordedEndsNote([
    { jobId: "job-1", command: "a", exit_code: 0, log_path: "/j/1.log" },
    { jobId: "job-2", command: "b", killed: true, log_path: "/j/2.log" },
  ]);
  assert.match(two!, /2 commands you started ended; nothing woke you for them:\n- job-1 \(exit 0\): a — log \/j\/1.log\n- job-2 \(stopped at the cap\): b — log \/j\/2.log/);
});
