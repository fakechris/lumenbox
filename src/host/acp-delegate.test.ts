/**
 * Delegate as a session, host side (docs/81 §3): the brief settles on the engine's word, a
 * steer is delivered not adopted, a cancel is aborted, the engine's permission question is the
 * gate's — allow-once or deny, never allow-always — and an unanswered one ends the turn; after
 * a restart the session is watched again, loaded, or failed definitely.
 *
 * The "box" is the real boxd ACP service running the fake engine in-process: hermetic, and the
 * same code path the box runs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpService } from "../boxd/acp-service.ts";
import { AcpDelegates, type AcpBox } from "./acp-delegate.ts";
import { PendingWork } from "./pending-work.ts";
import { PolicyGate } from "./policy.ts";

const ENGINE = fileURLToPath(new URL("../boxd/testing/fake-acp-engine.mjs", import.meta.url));
const command = `node ${ENGINE}`;

/** The box client's ACP face, served by the real service. */
/** What the engine "wrote" as its report file, for the keeper to read at settling (INV-1261); undefined is no file. */
let anyReport: string | undefined;
const OK_REPORT = JSON.stringify({ done: [{ what: "said hello", evidence: { kind: "command", command: "echo hi", output: "hi" } }], not_done: [], problems: [], verdict: "done" });

function boxOver(acp: AcpService, env: Record<string, string> = {}): AcpBox {
  const base = { nice: 0, scrubbedEnv: { PATH: process.env.PATH ?? "", ...env } as NodeJS.ProcessEnv };
  return {
    readFile: async (path: string) => {
      if (anyReport === undefined || !path.includes("/.lumenbox/reports/")) throw new Error(`${path} does not exist`);
      return { path, content: anyReport, total_lines: 1, truncated: false };
    },
    acpOpen: async request => acp.open({ ...request, ...base }),
    acpSend: async request => acp.send(request),
    acpReply: async request => {
      acp.reply(request);
      return { ok: true };
    },
    acpEvents: async request => acp.events(request),
    acpClose: async request => (await acp.close(request))!,
    acpSessions: async () => ({ sessions: acp.list() }),
  };
}

function fixture(options: { commandsNeedingConsent?: string[]; consentWaitMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "acp-delegate-"));
  const pendingWork = new PendingWork(join(dir, "pending-work.jsonl"));
  const policy = new PolicyGate({
    path: join(dir, "policy.jsonl"),
    limits: { approvalRequiredTools: [], approvalRequiredCommands: options.commandsNeedingConsent ?? [], maxRoundsPerTurn: 400, maxTurnsPerHour: 1000 } as never,
  });
  const acp = new AcpService(dir);
  const notes: { agentId: string; text: string; conversation: string }[] = [];
  const delegates = new AcpDelegates({
    pendingWork,
    policy,
    deliver: (agentId, text, conversation) => notes.push({ agentId, text, conversation }),
    eventsTimeoutMs: 300,
    consentPollMs: 5,
    ...(options.consentWaitMs !== undefined ? { consentWaitMs: options.consentWaitMs } : {}),
  });
  const start = (prompt: string, env: Record<string, string> = {}) =>
    delegates.start({ box: boxOver(acp, env), agentId: "a1", agentName: "Ada", conversation: "main", engine: "fake", command, cwd: dir, env, prompt }, `job-${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`);
  const settledNote = async (predicate: (text: string) => boolean = () => true, limitMs = 10_000) => {
    const end = Date.now() + limitMs;
    while (Date.now() < end) {
      const found = notes.find(note => predicate(note.text));
      if (found !== undefined) return found;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`no note within ${limitMs}ms; have: ${notes.map(n => n.text.slice(0, 80)).join(" | ")}`);
  };
  const committed = () =>
    readFileSync(join(dir, "pending-work.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event: string; how?: string; why?: string; data?: Record<string, unknown>; child?: string });
  return { dir, pendingWork, policy, acp, delegates, notes, start, settledNote, committed, cleanup: () => { acp.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a brief settles on the engine's end_turn: done, the answer in the note, the record marked a session", async () => {
  const f = fixture();
  try {
    anyReport = OK_REPORT;
    const started = await f.start("say hello");
    const note = await f.settledNote();
    assert.match(note.text, /finished: job-.*fake: say hello/);
    assert.match(note.text, /Its report: verdict done\. done: said hello/);
    assert.match(note.text, /Its answer: Done\./);
    assert.match(note.text, /session stays open: continue it with Delegate session_id=/);
    const records = f.committed();
    const prepared = records.find(r => r.event === "prepared");
    assert.equal(prepared?.data?.mode, "session");
    assert.equal(prepared?.data?.engineSessionId, started.engineSessionId);
    assert.equal(prepared?.data?.cwd, f.dir);
    assert.equal(records.find(r => r.event === "committed")?.how, "done");
    assert.equal(f.delegates.get(started.jobId)?.inFlight, undefined, "nothing in flight after the answer");
    // The next brief on the same session: a second record, settled the same way.
    // The next brief delivers no report: its end_turn is a claim with nothing behind it.
    anyReport = undefined;
    await f.delegates.continueWith(started.jobId, "and again", { engine: "fake" });
    const second = await f.settledNote(text => /and again/.test(text));
    assert.match(second.text, /whether it did the work is unknown.*delivered no report/);
    assert.deepEqual(f.committed().filter(r => r.event === "committed").map(r => r.how), ["done", "unknown"]);
    await f.delegates.close(started.jobId);
  } finally {
    f.cleanup();
  }
});

test("steer: idle is idle, delivered mid-turn, a repeat is a duplicate; cancel settles the brief as aborted", async () => {
  const f = fixture();
  try {
    const started = await f.start("SLOW brief");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await f.delegates.steer(started.jobId, "also the tests"), "delivered");
    assert.equal(await f.delegates.steer(started.jobId, "also the tests"), "duplicate");
    assert.equal(await f.delegates.cancel(started.jobId), true);
    const note = await f.settledNote();
    assert.match(note.text, /stopped before it finished.*the engine confirmed the cancel/i);
    assert.equal(f.committed().find(r => r.event === "committed")?.how, "aborted");
    assert.equal(await f.delegates.cancel(started.jobId), false, "nothing in flight to cancel");
    assert.equal(await f.delegates.steer(started.jobId, "now?"), "idle");
    await f.delegates.close(started.jobId);
  } finally {
    f.cleanup();
  }
});

test("the engine's permission question goes to the gate: granted is allow-once, refused is deny, never allow-always", async () => {
  const f = fixture({ commandsNeedingConsent: ["curl"] });
  try {
    const started = await f.start("ASK before running");
    const until = Date.now() + 5_000;
    while (f.policy.pending().length === 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    const [pending] = f.policy.pending();
    assert.ok(pending, "the person is asked");
    assert.match(pending!.description, /\[delegated engine job-.*\] Ada: bash — curl http:\/\/example\.com/);
    f.policy.grant(pending!.id, "test");
    const granted = await f.settledNote();
    assert.match(granted.text, /unknown.*delivered no report/, "end_turn without a report is a claim, not a result (INV-1261)");
    // The engine's answer is only quoted for a done brief; that the tool ran is in the session log below.

    f.notes.length = 0;
    await f.delegates.continueWith(started.jobId, "ASK again", { engine: "fake" });
    const askedAgain = Date.now() + 5_000;
    while (f.policy.pending().length === 0 && Date.now() < askedAgain) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.policy.pending().length, 1, "asked again");
    f.policy.deny(f.policy.pending()[0]!.id, "test", "no");
    await f.settledNote();
    assert.equal(f.policy.pending().length, 0, "the re-check's request was withdrawn");
    const log = readFileSync(join(f.dir, `${started.jobId}.log`), "utf8");
    const answers = log.split("\n").filter(line => line.startsWith(">> ") && line.includes('"outcome"'));
    assert.equal(answers.length, 2);
    assert.ok(answers.every(line => !line.includes("allow-always")), "a standing grant is never given to an engine");
    assert.match(answers[0]!, /allow-once/);
    assert.match(answers[1]!, /"deny"/);
    await f.delegates.close(started.jobId);
  } finally {
    f.cleanup();
  }
});

test("a permission question nobody answers ends the turn: deny, then session/cancel, then aborted", async () => {
  const f = fixture({ commandsNeedingConsent: ["curl"], consentWaitMs: 100 });
  try {
    const started = await f.start("ASK and wait");
    const note = await f.settledNote();
    // The engine was answered deny and the turn was told to end; whichever the engine confirms
    // first settles the brief — what must not happen is a turn held open on a silent question.
    assert.match(note.text, /stopped before it finished|unknown.*delivered no report/);
    assert.ok(["aborted", "unknown"].includes(f.committed().find(r => r.event === "committed")?.how ?? ""));
    assert.equal(f.policy.pending().length, 0);
    const log = readFileSync(join(f.dir, `${started.jobId}.log`), "utf8");
    assert.match(log, />> .*"session\/cancel"/, "the host ended the turn rather than leave it waiting");
    assert.match(log, />> .*"optionId":"deny"/);
    await f.delegates.close(started.jobId);
  } finally {
    f.cleanup();
  }
});

test("the engine dying mid-brief is a failed brief, and the session is gone from the host", async () => {
  const f = fixture();
  try {
    const started = await f.start("CRASH now");
    const note = await f.settledNote();
    assert.match(note.text, /failed.*the engine exited \(3\)/i);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(f.delegates.get(started.jobId), undefined);
  } finally {
    f.cleanup();
  }
});

test("an error response to the prompt is a failed brief with the engine's words", async () => {
  const f = fixture();
  try {
    const started = await f.start("FAIL please");
    const note = await f.settledNote();
    assert.match(note.text, /failed.*fake provider error/i);
    await f.delegates.close(started.jobId);
  } finally {
    f.cleanup();
  }
});

test("after a host restart a running session is watched again; after a box restart it is loaded in its cwd, or failed", async () => {
  const f = fixture();
  const state = join(f.dir, "fake-state.json");
  try {
    const started = await f.start("SLOW remembered", { FAKE_ACP_STATE: state });
    await new Promise(resolve => setTimeout(resolve, 50));
    const open = f.pendingWork.open().filter(item => item.kind === "delegate");
    assert.equal(open.length, 1);
    const item = (brief = open[0]!) => ({ agentId: "a1", agentName: "Ada", conversation: "main", jobId: brief.child, brief: brief.brief, data: brief.data as never });

    // Host restart only: the box still runs the engine; a fresh keeper picks the brief up and it settles done.
    f.delegates.stop();
    const notes2: string[] = [];
    const second = new AcpDelegates({ pendingWork: f.pendingWork, policy: f.policy, deliver: (_a, text) => notes2.push(text), eventsTimeoutMs: 300 });
    await second.reattach(boxOver(f.acp), [item()]);
    const until = Date.now() + 10_000;
    while (notes2.length === 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(notes2[0] ?? "", /job-.*SLOW remembered/);
    assert.match(notes2[0] ?? "", /unknown.*delivered no report|finished/);
    await second.close(started.jobId);

    // Box restart: the service is new, the record is detached. Loaded in the same cwd → the brief
    // in flight is unknown and the session is usable again.
    const again = await f.start("SLOW second", { FAKE_ACP_STATE: state });
    await new Promise(resolve => setTimeout(resolve, 50));
    // The host goes first (its keeper stops watching), then the box: the record is all that is left.
    f.delegates.stop();
    f.acp.shutdown();
    await new Promise(resolve => setTimeout(resolve, 200));
    const reborn = new AcpService(f.dir);
    const notes3: string[] = [];
    const third = new AcpDelegates({ pendingWork: f.pendingWork, policy: f.policy, deliver: (_a, text) => notes3.push(text), eventsTimeoutMs: 300 });
    const brief2 = f.pendingWork.open().find(i => i.child === again.jobId)!;
    await third.reattach(boxOver(reborn, { FAKE_ACP_STATE: state }), [item(brief2)]);
    // Settling reads the report file and the tree before it speaks; give it a moment.
    const spoke = Date.now() + 5_000;
    while (notes3.length === 0 && Date.now() < spoke) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(notes3[0] ?? "", /whether it did the work is unknown.*session was loaded again/);
    assert.ok(third.get(again.jobId), "the session is open again");
    await third.close(again.jobId);

    // A record whose cwd the engine does not have: failed, definitely, no retry.
    const bad = { ...item(brief2), jobId: "job-deadbeef", data: { ...(brief2.data as object), cwd: join(f.dir, "elsewhere") } as never };
    const pw = f.pendingWork.prepare({ agentId: "a1", kind: "delegate", parent: "main", child: "job-deadbeef", brief: "fake: lost", data: bad.data as Record<string, unknown> });
    f.pendingWork.admitted(pw, undefined);
    // The box has no such session at all.
    const notes4: string[] = [];
    const fourth = new AcpDelegates({ pendingWork: f.pendingWork, policy: f.policy, deliver: (_a, text) => notes4.push(text), eventsTimeoutMs: 300 });
    await fourth.reattach(boxOver(reborn), [{ ...bad, brief: "fake: lost" }]);
    const spoke4 = Date.now() + 5_000;
    while (notes4.length === 0 && Date.now() < spoke4) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(notes4[0] ?? "", /failed.*no longer has this session/i);
    reborn.shutdown();
  } finally {
    f.cleanup();
  }
});
