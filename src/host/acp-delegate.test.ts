/**
 * Delegate as a session, host side (docs/81 §3): the brief settles on the engine's word, a
 * steer is delivered not adopted, a cancel is aborted, the engine's permission question is the
 * gate's — allow-once or deny, never allow-always — and an unanswered one ends the turn; after
 * a restart the session is watched again, loaded, or failed definitely.
 *
 * The "box" is the real boxd ACP service running the fake engine in-process: hermetic, and the
 * same code path the box runs.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AcpService } from "../boxd/acp-service.ts";
import { type AcpBox, AcpDelegates } from "./acp-delegate.ts";
import { PendingWork } from "./pending-work.ts";
import { PolicyGate } from "./policy.ts";

const ENGINE = fileURLToPath(new URL("../boxd/testing/fake-acp-engine.mjs", import.meta.url));
const command = `node ${ENGINE}`;

/** The box client's ACP face, served by the real service. */
/** What the engine "wrote" as its report file, for the keeper to read at settling (INV-1261); undefined is no file. */
let anyReport: string | undefined;
/** Where the session is told its report goes; the keeper must read that file and no other (INV-1712). */
const REPORT_FILE = "/work/.lumenbox/reports/brief.json";
const OK_REPORT = JSON.stringify({ done: [{ what: "said hello", evidence: { kind: "command", command: "echo hi", output: "hi" } }], not_done: [], problems: [], verdict: "done" });

function boxOver(acp: AcpService, env: Record<string, string> = {}): AcpBox {
  const base = { nice: 0, scrubbedEnv: { PATH: process.env.PATH ?? "", ...env } as NodeJS.ProcessEnv };
  return {
    readFile: async (path: string) => {
      if (anyReport === undefined || path !== REPORT_FILE) throw new Error(`${path} does not exist`);
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

function fixture(options: { commandsNeedingConsent?: string[]; consentWaitMs?: number; cancelGraceMs?: number } = {}) {
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
    ...(options.cancelGraceMs !== undefined ? { cancelGraceMs: options.cancelGraceMs } : {}),
  });
  const start = (prompt: string, env: Record<string, string> = {}) =>
    delegates.start({ box: boxOver(acp, env), agentId: "a1", agentName: "Ada", conversation: "main", engine: "fake", command, cwd: dir, env, prompt, report: REPORT_FILE }, `job-${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`);
  const settledNote = async (predicate: (text: string) => boolean = () => true, limitMs = 10_000) => {
    const end = Date.now() + limitMs;
    while (Date.now() < end) {
      const found = notes.find(note => predicate(note.text));
      if (found !== undefined) return found;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`no note within ${limitMs}ms; have: ${notes.map(n => n.text.slice(0, 80)).join(" | ")}`);
  };
  /** The log is a write stream: a line sent a moment ago may not be on disk yet, so it is polled for. */
  const logHas = async (jobId: string, pattern: RegExp, limitMs = 3_000) => {
    const end = Date.now() + limitMs;
    let log = "";
    while (Date.now() < end) {
      try { log = readFileSync(join(dir, `${jobId}.log`), "utf8"); } catch { log = ""; }
      if (pattern.test(log)) return log;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return log;
  };
  const committed = () =>
    readFileSync(join(dir, "pending-work.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event: string; how?: string; why?: string; data?: Record<string, unknown>; child?: string });
  return { dir, pendingWork, policy, acp, delegates, notes, start, settledNote, logHas, committed, cleanup: () => { acp.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
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
    const prepared = records.find(r => r.event === "prepared" && r.data?.mode === "session");
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
    const box = f.delegates.get(started.jobId)!.box;
    const originalSend = box.acpSend.bind(box);
    let releaseSend!: () => void;
    const sendingGate = new Promise<void>(resolve => { releaseSend = resolve; });
    box.acpSend = async request => { const response = await originalSend(request); await sendingGate; return response; };
    const admission = f.delegates.continueWith(started.jobId, "SLOW new work", { engine: "fake", workId: "other-work" });
    try {
      assert.equal(f.delegates.get(started.jobId)?.inFlight?.workId, "other-work", "cancellation sees new ownership before send acknowledges");
      await assert.rejects(f.delegates.continueWith(started.jobId, "duplicate", { engine: "fake" }), /still working/);
    } finally { releaseSend(); await admission; box.acpSend = originalSend; }
    await f.delegates.cancel(started.jobId);
    await f.settledNote(text => /SLOW new work/.test(text));
    const originalClose = box.acpClose.bind(box);
    let releaseClose!: () => void;
    const closingGate = new Promise<void>(resolve => { releaseClose = resolve; });
    box.acpClose = async request => { await closingGate; return originalClose(request); };
    const closing = f.delegates.close(started.jobId, "old work cancelled");
    try {
      await assert.rejects(f.delegates.continueWith(started.jobId, "new unrelated work", { engine: "fake", workId: "other-work" }), /closing or closed/);
      assert.equal(f.delegates.get(started.jobId)?.inFlight, undefined, "closing an idle session must not admit and then abort new work");
    } finally { releaseClose(); await closing; }
    const uncertain = await f.start("check before lost acknowledgement");
    await f.settledNote(text => /check before lost acknowledgement/.test(text));
    f.delegates.get(uncertain.jobId)!.box.acpSend = async () => { throw new Error("send acknowledgement lost"); };
    await assert.rejects(f.delegates.continueWith(uncertain.jobId, "uncertain brief", { engine: "fake", workId: "uncertain-work" }), /send acknowledgement lost/);
    assert.equal(f.delegates.get(uncertain.jobId), undefined, "a failed admission with confirmed cleanup does not wedge the session busy");
    await f.settledNote(text => /closed after the brief acknowledgement was lost/i.test(text));
    assert.equal(f.pendingWork.open().filter(work => work.child === uncertain.jobId).length, 0, "the uncertain admission is durably settled after cleanup");
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
    const log = await f.logHas(started.jobId, /"outcome"/);
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
    const log = await f.logHas(started.jobId, />> .*"session\/cancel"/);
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

test("an engine that ignores the cancel: the host settles the brief as aborted after the grace and closes the session (INV-1310)", async () => {
  const f = fixture({ cancelGraceMs: 300 });
  try {
    const started = await f.start("SLOW IGNORE_CANCEL keep going");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await f.delegates.cancel(started.jobId), true);
    const note = await f.settledNote();
    assert.match(note.text, /stopped before it finished|aborted/i);
    const row = f.committed().find(r => r.event === "committed");
    assert.equal(row?.how, "aborted");
    assert.match(row?.why ?? "", /the agent cancelled the brief; the engine did not confirm the cancel within 0s, so the host closed the session/);
    assert.equal(f.delegates.get(started.jobId), undefined, "the session is gone from the host");
    // The stopped report follows the close acknowledgement, never precedes it.
    assert.equal(f.acp.list().some(s => s.session_id === started.jobId), false, "and from the box");
  } finally {
    f.cleanup();
  }
});

test("consent times out and the engine ignores the cancel that follows: aborted by the host, the record naming both layers (INV-1310)", async () => {
  const f = fixture({ commandsNeedingConsent: ["curl"], consentWaitMs: 100, cancelGraceMs: 300 });
  try {
    const started = await f.start("ASK IGNORE_CANCEL and wait");
    const note = await f.settledNote();
    assert.match(note.text, /stopped before it finished|aborted/i);
    const row = f.committed().find(r => r.event === "committed");
    assert.equal(row?.how, "aborted");
    assert.match(row?.why ?? "", /nobody answered the engine's permission question within the consent wait; the engine did not confirm the cancel within 0s/);
    assert.equal(f.policy.pending().length, 0, "the question was withdrawn");
    assert.equal(f.delegates.get(started.jobId), undefined);
    // A stop report is not emitted while the host is still waiting for close.
    assert.equal(f.acp.list().some(s => s.session_id === started.jobId), false, "the session is gone from the box");
  } finally {
    f.cleanup();
  }
});

test("an engine that confirms the cancel settles on its own word, and the grace changes nothing (INV-1310)", async () => {
  const f = fixture({ cancelGraceMs: 5_000 });
  try {
    const started = await f.start("SLOW keep going");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await f.delegates.cancel(started.jobId), true);
    const note = await f.settledNote();
    const row = f.committed().find(r => r.event === "committed");
    assert.equal(row?.how, "aborted");
    assert.match(row?.why ?? "", /the engine confirmed the cancel/);
    assert.ok(note !== undefined);
    assert.notEqual(f.delegates.get(started.jobId), undefined, "the session stays open for the next brief");
    await f.delegates.close(started.jobId);
  } finally {
    f.cleanup();
  }
});

test("an exit arriving before the close response waits for that response; a rejected close remains observable", async () => {
  for (const rejected of [false, true]) {
    let publish!: (page: Awaited<ReturnType<AcpBox["acpEvents"]>>) => void;
    const page = new Promise<Awaited<ReturnType<AcpBox["acpEvents"]>>>(resolve => { publish = resolve; });
    let confirm!: () => void, refuse!: (error: Error) => void, closes = 0;
    const acknowledgement = new Promise<void>((resolve, reject) => { confirm = resolve; refuse = reject; });
    const notes: string[] = [];
    const box = {
      acpOpen: async () => ({ engine_session_id: "session", log_path: "/fixture/log" }),
      acpSend: async () => ({ rpc_id: 1 }),
      acpEvents: async () => page,
      acpClose: async () => { closes++; await acknowledgement; return {}; },
    } as unknown as AcpBox;
    let reachedGrace!: () => void;
    const graceReached = new Promise<void>(resolve => { reachedGrace = resolve; });
    const delegates = new AcpDelegates({ deliver: (_agent, text) => notes.push(text), cancelGraceMs: 1,
      log: text => { if (text.includes("did not confirm the cancel")) reachedGrace(); } });
    try {
      await delegates.start({ box, agentId: "a", agentName: "A", conversation: "main", engine: "fake", command: "unused", cwd: "/fixture", env: {}, prompt: "work", report: "/fixture/report" }, "job-close");
      await delegates.cancel("job-close");
      const closing = delegates.close("job-close");
      // Observe both callers now so the deliberately rejected operation is handled.
      const results = Promise.allSettled([closing, delegates.close("job-close")]);
      publish({ events: [], last_seq: 0, running: false, exit_code: 0 });
      await graceReached;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(notes.length, 0, "neither an exit nor an expired cancel grace can confirm a pending close");
      assert.ok(delegates.get("job-close")?.inFlight, "pending is not stopped");
      assert.equal(closes, 1, "concurrent close requests share one operation");
      if (rejected) refuse(new Error("close acknowledgement lost")); else confirm();
      const outcomes = await results;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(outcomes.every(outcome => outcome.status === (rejected ? "rejected" : "fulfilled")));
      assert.equal(notes.length, 1, "the brief is settled exactly once");
      assert.match(notes[0]!, rejected ? /engine exited/ : /session was closed by the agent/);
      assert.doesNotMatch(notes[0]!, /session stays open/, "a closed session must not invite continued work");
      assert.equal(delegates.get("job-close"), undefined);
    } finally { delegates.stop(); }
  }
});
