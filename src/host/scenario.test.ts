/**
 * The episodes that went wrong, as tests.
 *
 * Each scenario below is a real run a person complained about, reduced to the shape that made it
 * bad and scripted so it runs in a second. The model in each is written to behave the way the
 * real one did — the point is not that a good model would do better, it is that the harness holds
 * the shape even when the model does not.
 *
 * Add one here whenever a run goes wrong. That is the whole discipline: the complaint becomes a
 * scorecard assertion, and the next regression fails the build instead of the person's afternoon.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runEpisode, type Script } from "./scenario.ts";

// ── 2026-09-09, "build the team from this post" ───────────────────────────────────────────
//
// What happened: Bot Boss asked a four-option question before doing anything, dr eggbot created
// five agents and then spent three turns polling `/tmp/boxd-session-*` for files that never
// arrive, reported a false failure, corrected itself, and the two of them exchanged ten messages
// of apologies. Thirteen minutes, no content produced.
//
// What the harness must hold: a created agent is on the roster the instant the call returns, and
// the call says so, so there is nothing to poll for.

test("creating a team: every agent is live at once, in the creator's box, and told who made it", async () => {
  const script: Script = ({ agent, round }) => {
    if (agent === "Boss" && round === 0) {
      return { call: "SendToAgent", input: { target_id: "Maker", message: "build the five: scout, brief, draft, factcheck, analytics" } };
    }
    if (agent === "Maker") {
      const names = ["scout", "brief", "draft", "factcheck", "analytics"];
      if (round < names.length) {
        return { call: "CreateAgent", input: { name: names[round], description: `ONLY job: the ${names[round]} stage. Anti-jobs: the others. Voice: plain. Wake: when routed to.` } };
      }
      if (round === names.length) return { say: "five made" };
    }
    return { say: "ok" };
  };

  const episode = await runEpisode({ team: [{ name: "Boss" }, { name: "Maker" }], says: ["build the content team"], script });
  try {
    const { score } = episode;
    for (const name of ["scout", "brief", "draft", "factcheck", "analytics"]) {
      assert.ok(score.agents.includes(name), `${name} is on the roster: ${score.agents.join(", ")}`);
    }
    // Each new agent heard from its creator, so none of them sits silent waiting to be noticed.
    const greeted = episode.observations.filter(o => o.kind === "message" && /just created by Maker/.test(o.text ?? ""));
    assert.equal(greeted.length, 5, "each new agent got its first message");
    // And the tool said it plainly, which is what stops the polling.
    const created = episode.registry.list().find(record => record.profile.name === "scout");
    assert.ok(created !== undefined);
    assert.equal(episode.registry.boxOf(created.id).id, episode.registry.boxOf(episode.registry.list().find(r => r.profile.name === "Maker")!.id).id, "created beside its creator");
  } finally {
    episode.cleanup();
  }
});

// ── 2026-09-08, dr eggbot's interview ─────────────────────────────────────────────────────
//
// What happened: asked to create one agent, dr eggbot asked the person five preference questions
// in a row — for an agent that did not exist yet, so every answer landed in the wrong memory.

test("a run of questions is cut off at two, and the refusal says to decide", async () => {
  let asked = 0;
  const script: Script = ({ agent }) => {
    if (agent !== "Asker") return { say: "ok" };
    asked += 1;
    return { call: "AskUser", input: { question: `question ${asked}?`, options: ["a", "b"], default: "a" } };
  };
  const episode = await runEpisode({ team: [{ name: "Asker" }], says: ["make me a pi development agent"], script, maxRounds: 12 });
  try {
    assert.equal(episode.score.questions, 2, `two questions reached the person, not ${episode.score.questions}`);
    assert.ok(episode.score.questionsRefused >= 1, `the rest were refused: ${episode.score.refusals.join(" | ")}`);
    assert.match(episode.score.refusals.join(" "), /Decide this one yourself/);
  } finally {
    episode.cleanup();
  }
});

// ── 2026-09-08, the peer that interrogated the person ─────────────────────────────────────
//
// What happened: a teammate woken by another agent asked the person a question, in a chat the
// person was not reading. The person was talking to the front agent.

test("a teammate woken by an agent is not offered a line to the person", async () => {
  // The first offering of each agent's first turn: the front agent is woken again later by the
  // helper's reply, and what matters is what each was offered when it was asked to work.
  const offeredTo: Record<string, string[]> = {};
  const script: Script = ({ agent, round, offered }) => {
    if (offeredTo[agent] === undefined) offeredTo[agent] = offered;
    if (agent === "Front" && round === 0) return { call: "SendToAgent", input: { target_id: "Helper", message: "which colour should it be?" } };
    if (agent === "Helper") return { say: "I need the person to pick a colour; you ask them." };
    return { say: "will ask them" };
  };
  const episode = await runEpisode({ team: [{ name: "Front" }, { name: "Helper" }], says: ["do the thing"], script });
  try {
    assert.ok(offeredTo.Front?.includes("AskUser"), "the front agent keeps it");
    assert.ok(offeredTo.Helper !== undefined, "the helper ran");
    assert.ok(!offeredTo.Helper.includes("AskUser"), `withheld from the helper: ${offeredTo.Helper.join(", ")}`);
    assert.ok(!offeredTo.Helper.includes("AskSecret"));
    // And the front agent keeps it even when a teammate woke it — it is the one the person is
    // talking to, so a decision that comes back from a worker has somewhere to go.
    const laterFront = episode.observations.filter(o => o.kind === "turn" && o.agent === "Front").length;
    assert.ok(laterFront >= 2, "the front agent was woken again by the helper");
    // And what it said came back to the sender rather than nowhere.
    const back = episode.observations.find(o => o.kind === "message" && o.agent === "Helper" && o.to === "Front");
    assert.ok(back !== undefined, "the helper's prose reached the front agent");
  } finally {
    episode.cleanup();
  }
});

// ── 2026-09-08, the front agent that disappeared into the work ────────────────────────────
//
// What happened: heavy work ran inline, so the person watched nothing happen for minutes with no
// signal, and a second message could not be answered until it finished.

test("heavy work goes to a background fork and the front agent answers immediately", async () => {
  const script: Script = ({ agent, system, round }) => {
    if (round === 0 && /You are a fork/.test(system) === false) {
      return { call: "Fork", input: { briefs: ["read all of it and report"], background: true } };
    }
    if (/You are a fork/.test(system)) return { say: 'the answer is 42\nHANDOFF: {"status":"done"}' };
    void agent;
    return { say: "On it — I'll come back with what it says." };
  };
  const episode = await runEpisode({ team: [{ name: "Front" }], says: ["go through the whole log and tell me what broke"], script });
  try {
    const { score } = episode;
    // The person heard something, and it was not about forking.
    assert.ok(score.said.length > 0, "the front agent said something");
    assert.ok(!/fork|delegat|dispatch/i.test(score.said.map(s => s.text).join(" ")), `machinery stayed private: ${score.said.map(s => s.text).join(" | ")}`);
    // The finding came back on its own turn rather than inside the first one.
    const landed = episode.observations.find(o => o.kind === "message" && /A fork you started has finished/.test(o.text ?? ""));
    assert.ok(landed !== undefined, `the fork reported back: ${episode.observations.filter(o => o.kind === "message").map(o => o.text?.slice(0, 40)).join(" | ")}`);
  } finally {
    episode.cleanup();
  }
});

// ── 2026-09-09, the tool that belongs to another product ──────────────────────────────────
//
// What happened: an agent found `update_state` in Grok Bot's transcripts on the shared VM,
// concluded it was a real capability it was missing, and spent four turns and a question to the
// person on a plugin that does not exist here.

test("the prompt says what is not yours on a shared machine", async () => {
  const seen: string[] = [];
  const script: Script = ({ system }) => {
    seen.push(system);
    return { say: "ok" };
  };
  const episode = await runEpisode({ team: [{ name: "Solo" }], says: ["set up a weekly routine"], script });
  try {
    const system = seen.join("\n");
    assert.match(system, /Other software may share this machine/);
    assert.match(system, /update_state/, "the tool that caused it is named");
    assert.match(system, /skill file\s*\n?with a .schedule:. line/, "and our own mechanism is named instead");
  } finally {
    episode.cleanup();
  }
});
