/**
 * Tests for picking a turn back up after the process ended underneath it.
 *
 * Three claims. A turn that began and never ended is *known* to have been interrupted rather than
 * guessed at. Resuming re-executes nothing — it reopens the conversation and lets the agent read
 * its own history. And a turn that kills the process is not retried forever, because a crash loop
 * that restarts itself is worse than a task that stopped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  giveUpNote,
  MAX_RESUMES,
  resumePrompt,
  TurnLedger,
  type InterruptedTurn,
} from "./resume.ts";

function ledgerPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-turns-"));
  return { path: join(dir, "turns.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a turn that began and never ended is the one that was interrupted", () => {
  const { path, cleanup } = ledgerPath();
  try {
    const ledger = new TurnLedger(path);
    ledger.begin({ id: "t1", agentId: "ada", about: "write the report" });
    ledger.end("t1", "done");
    ledger.begin({ id: "t2", agentId: "ada", about: "deploy the thing" });
    // t2 never ends: the process died here.

    // A fresh process reads the file, which is the only reason this is a fact and not a guess.
    const outstanding = new TurnLedger(path).interrupted();
    assert.deepEqual(
      outstanding.map((turn: InterruptedTurn) => turn.id),
      ["t2"]
    );
    assert.equal(outstanding[0]?.about, "deploy the thing");
    assert.equal(outstanding[0]?.attempt, 1);
  } finally {
    cleanup();
  }
});

test("however a turn ends, it is not outstanding", () => {
  const { path, cleanup } = ledgerPath();
  try {
    const ledger = new TurnLedger(path);
    for (const [id, how] of [
      ["t1", "done"],
      ["t2", "failed"],
      ["t3", "aborted"],
    ] as const) {
      ledger.begin({ id, agentId: "ada", about: id });
      ledger.end(id, how);
    }
    // A failure and an abort are ends. Leaving them open would have the next startup resume
    // something that already reported itself, which reads as the agent repeating itself for no
    // reason.
    assert.deepEqual(new TurnLedger(path).interrupted(), []);
  } finally {
    cleanup();
  }
});

test("attempts accumulate across resumptions, which is the crash-loop guard", () => {
  const { path, cleanup } = ledgerPath();
  try {
    const ledger = new TurnLedger(path);
    ledger.begin({ id: "t1", agentId: "ada", about: "the thing that kills us" });
    // The resumption closes the old entry and opens a linked one, so exactly one turn is ever
    // outstanding no matter how many times this happens.
    ledger.end("t1", "resumed");
    ledger.begin({
      id: "t2",
      agentId: "ada",
      about: "the thing that kills us",
      resumeOf: "t1",
      attempt: 2,
    });

    const outstanding = new TurnLedger(path).interrupted();
    assert.equal(outstanding.length, 1);
    assert.equal(outstanding[0]?.attempt, 2);
    assert.ok(MAX_RESUMES >= 2, "and two attempts is enough to tell a restart from a poison turn");
  } finally {
    cleanup();
  }
});

test("a clean shutdown marks its open turns, and the marker survives replay", () => {
  // The measured failure (2026-09-01): two operator restarts inside one minute spent a
  // healthy turn's whole resume budget and it was given up on. The marker is what lets
  // the resume tell "the operator ended the process" from "this turn ended the process".
  const { path, cleanup } = ledgerPath();
  try {
    const ledger = new TurnLedger(path);
    ledger.begin({ id: "t1", agentId: "ada", about: "healthy long task" });
    ledger.markClean("t1");

    const outstanding = new TurnLedger(path).interrupted();
    assert.equal(outstanding.length, 1);
    assert.equal(outstanding[0]?.cleanExit, true, "the interruption is known to be on purpose");

    // A crash-interrupted turn carries no marker — the budget still applies to it.
    ledger.begin({ id: "t2", agentId: "bob", about: "the thing that kills us" });
    const both = new TurnLedger(path).interrupted();
    assert.equal(both.find(turn => turn.id === "t2")?.cleanExit, undefined);

    // The marker belongs to the interruption, not the work: once t1 resumes as a new
    // turn and that one is crash-interrupted, the new turn is judged on its own.
    ledger.end("t1", "resumed");
    ledger.begin({ id: "t3", agentId: "ada", about: "healthy long task", resumeOf: "t1", attempt: 1 });
    const after = new TurnLedger(path).interrupted();
    assert.equal(after.find(turn => turn.id === "t3")?.cleanExit, undefined);
  } finally {
    cleanup();
  }
});

test("a torn last line costs one turn, not the file", () => {
  const { path, cleanup } = ledgerPath();
  try {
    writeFileSync(
      path,
      `${JSON.stringify({ id: "t1", event: "begin", agentId: "ada", at: "2026-08-20T10:00:00.000Z", attempt: 1, about: "real" })}\n` +
        `{"id":"t2","event":"begin","agentId":"ada","at":"2026`
    );
    const outstanding = new TurnLedger(path).interrupted();
    assert.deepEqual(outstanding.map(turn => turn.id), ["t1"]);
  } finally {
    cleanup();
  }
});

test("no ledger configured means no file and nothing outstanding", () => {
  // `null`, not `undefined`: a default parameter fires on an explicit `undefined` too.
  const ledger = new TurnLedger(null);
  ledger.begin({ id: "t1", agentId: "ada", about: "x" });
  assert.deepEqual(ledger.interrupted(), []);
});

test("a resumed turn is told what it may not assume", () => {
  const prompt = resumePrompt("deploy the release", "2026-08-20T10:00:00.000Z");
  // Not a person asking: an agent that thinks someone is waiting asks clarifying questions nobody
  // will answer.
  assert.match(prompt, /\[resumed\]/);
  assert.match(prompt, /Nobody re-sent this/);
  assert.match(prompt, /deploy the release/);

  // The load-bearing sentence. The natural reading of an interrupted log is "it failed", and acting
  // on that undoes work that succeeded.
  assert.match(prompt, /unknown is what it means — it may well have succeeded/);
  assert.match(prompt, /check the state of anything you may have been part-way through/i);
  assert.match(prompt, /prefer looking over redoing/);
});

test("giving up says why, and says a person is needed", () => {
  const note = giveUpNote("deploy the release", 2);
  assert.match(note, /interrupted 2 times/);
  assert.match(note, /not being picked up again/);
  // The distinction that matters to whoever reads it: this is probably the work, not the machine.
  assert.match(note, /likely to be in this work rather than in the machine/);
  assert.match(note, /needs a person to look/);
});

test("a work id survives every resume of the same work", () => {
  const { path, cleanup } = ledgerPath();
  try {
    const ledger = new TurnLedger(path);
    // Three attempts at one piece of work: the process died twice underneath it.
    ledger.begin({ id: "t1", agentId: "ada", about: "the long one", workId: "w1" });
    ledger.end("t1", "resumed");
    ledger.begin({ id: "t2", agentId: "ada", about: "the long one", workId: "w1", resumeOf: "t1", attempt: 2 });
    ledger.end("t2", "resumed");
    ledger.begin({ id: "t3", agentId: "ada", about: "the long one", workId: "w1", resumeOf: "t2", attempt: 3 });

    const outstanding = new TurnLedger(path).interrupted();
    // The point of the whole field: three turn ids, one work id. A cost report keyed on turn
    // id sees three unrelated short turns where there was one long piece of work.
    assert.deepEqual(outstanding.map(turn => turn.id), ["t3"]);
    assert.equal(outstanding[0]?.workId, "w1");
    assert.equal(outstanding[0]?.attempt, 3);
  } finally {
    cleanup();
  }
});

test("interrupted() carries every field a resumption has to pass on", () => {
  const { path, cleanup } = ledgerPath();
  try {
    const ledger = new TurnLedger(path);
    ledger.begin({
      id: "t1",
      agentId: "ada",
      about: "in a side thread",
      workId: "w9",
      conversation: "feishu:oc_1",
    });
    const [turn] = new TurnLedger(path).interrupted();
    // Named individually because this shape has already lost a field once: resumeOf is written
    // into the record and dropped from what interrupted() returns, so the lineage exists on disk
    // and never reaches the code that resumes. A workId that did the same would make the whole
    // field a no-op that still typechecks.
    assert.equal(turn?.workId, "w9");
    assert.equal(turn?.conversation, "feishu:oc_1");
    assert.equal(turn?.agentId, "ada");
  } finally {
    cleanup();
  }
});

test("a ledger written before workId existed still replays", () => {
  const { path, cleanup } = ledgerPath();
  try {
    // Exactly what an older build wrote: no workId anywhere.
    writeFileSync(
      path,
      `${JSON.stringify({ id: "old", event: "begin", agentId: "ada", at: new Date(0).toISOString(), attempt: 1, about: "before the field" })}\n`
    );
    const [turn] = new TurnLedger(path).interrupted();
    assert.equal(turn?.id, "old");
    // Absent, not invented. A synthesised id would join this turn's rows to nothing while
    // looking like a real grouping, which is worse than admitting the record predates the field.
    assert.equal(turn?.workId, undefined);
  } finally {
    cleanup();
  }
});

test("a begin record says which model, which build and which prompt produced the turn (R24)", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-resume-stamp-"));
  try {
    const path = join(root, "turns.jsonl");
    new TurnLedger(path).begin({
      id: "t-stamp",
      agentId: "a1",
      about: "stamped",
      model: "MiniMax-M3",
      build: { version: "0.31.0", commit: "abc1234" },
      promptHash: "0123456789abcdef",
    });
    const record = JSON.parse(readFileSync(path, "utf8").trim()) as Record<string, unknown>;
    assert.equal(record.model, "MiniMax-M3");
    assert.deepEqual(record.build, { version: "0.31.0", commit: "abc1234" });
    assert.equal(record.promptHash, "0123456789abcdef");
    // Still an open turn to the resumer, which ignores the stamp.
    assert.equal(new TurnLedger(path).interrupted().length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
