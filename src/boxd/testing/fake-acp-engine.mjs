#!/usr/bin/env node
/**
 * A stand-in for an engine's ACP surface (docs/81), shaped by what mcode 0.6.12 measured as:
 * newline-delimited JSON-RPC 2.0 on stdio, stdout protocol-only. It is what the boxd ACP
 * service and the host's session-mode Delegate are tested against, hermetically.
 *
 * What it does, keyed by words in the prompt text:
 *   SLOW     — the turn streams one word every 100 ms, so a steer or cancel lands mid-turn
 *   ASK      — the turn sends `session/request_permission` and waits for the answer; allowed
 *              → a tool_call_update completed and end_turn; denied → end_turn with a note
 *   CRASH    — the process exits 3 mid-turn without answering
 *   FAIL     — the prompt is answered with a JSON-RPC internalError
 *
 * State for `session/load`: a file FAKE_ACP_STATE (json: {sessionId, cwd}) if the env names
 * one, so a second process can load what the first created — or refuse a different cwd.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const state = process.env.FAKE_ACP_STATE;
let sessions = {};
if (state) {
  try {
    sessions = JSON.parse(readFileSync(state, "utf8"));
  } catch {
    sessions = {};
  }
}
const save = () => {
  if (state) writeFileSync(state, JSON.stringify(sessions));
};

const out = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const update = (sessionId, body) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });

let activeTurn;
let nextServerId = 0;
const serverWaits = new Map();
const steerSeen = new Set();

const rl = createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));
rl.on("line", line => {
  if (line.trim() === "") return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write(`fake-acp: unreadable ${line.slice(0, 80)}\n`);
    return;
  }
  // An answer to something we asked.
  if (message.id !== undefined && message.method === undefined) {
    const waiting = serverWaits.get(message.id);
    if (waiting) {
      serverWaits.delete(message.id);
      waiting(message);
    }
    return;
  }
  const { id, method, params = {} } = message;
  const reply = result => out({ jsonrpc: "2.0", id, result });
  const refuse = (code, text) => out({ jsonrpc: "2.0", id, error: { code, message: text } });

  switch (method) {
    case "initialize":
      reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } }, agentInfo: { name: "fake-acp", version: "0" } });
      return;
    case "session/new": {
      const sessionId = `fake_${Math.random().toString(16).slice(2, 10)}`;
      sessions[sessionId] = { cwd: params.cwd, history: [] };
      save();
      reply({ sessionId, modes: { currentModeId: "default", availableModes: [] }, configOptions: [] });
      return;
    }
    case "session/load": {
      const known = sessions[params.sessionId];
      if (!known) return refuse(-32002, `Resource not found: ${params.sessionId}`);
      if (known.cwd !== params.cwd) return refuse(-32602, `Invalid params: Requested cwd does not match the persisted session workspace: ${params.cwd}.`);
      for (const text of known.history) update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
      reply({ modes: { currentModeId: "default", availableModes: [] }, configOptions: [] });
      return;
    }
    case "session/set_config_option":
      reply({ configOptions: [{ id: params.configId, currentValue: params.value }] });
      return;
    case "session/prompt": {
      if (activeTurn) return refuse(-32602, "Invalid params: A prompt is already active for this session.");
      const text = (params.prompt ?? []).filter(p => p.type === "text").map(p => p.text).join(" ");
      const sessionId = params.sessionId;
      if (sessions[sessionId]) {
        sessions[sessionId].history.push(text);
        save();
      }
      if (text.includes("FAIL")) return refuse(-32603, "MiniMax Code Runtime failed: fake provider error");
      const turn = { id, sessionId, turnId: `turn_${id}`, cancelled: false, steers: [] };
      activeTurn = turn;
      const finish = stopReason => {
        if (activeTurn !== turn) return;
        activeTurn = undefined;
        update(sessionId, { sessionUpdate: "usage_update", used: 59, size: 200000 });
        reply({ stopReason });
      };
      const say = words => {
        for (const word of words) update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${word} ` } });
      };
      if (text.includes("CRASH")) {
        say(["about", "to"]);
        setTimeout(() => process.exit(3), 50);
        return;
      }
      if (text.includes("ASK")) {
        update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_1", title: "bash", kind: "execute", status: "pending", rawInput: { command: "curl http://example.com" } });
        const reqId = nextServerId++;
        serverWaits.set(reqId, answer => {
          if (turn.cancelled) return;
          const chosen = answer.result?.outcome?.optionId;
          if (chosen === "allow-once") {
            update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed", rawOutput: { content: [{ type: "text", text: "ok" }] } });
            say(["ran", "it."]);
          } else {
            update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "failed" });
            say(["not", "allowed."]);
          }
          finish("end_turn");
        });
        out({
          jsonrpc: "2.0",
          id: reqId,
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId: "perm_1", title: "bash", name: "bash", kind: "execute", status: "pending", rawInput: { command: "curl http://example.com" } },
            options: [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          },
        });
        return;
      }
      const words = (text.includes("SLOW") ? "working on it step by step reading every file carefully before answering at all".split(" ") : ["Done."]);
      let i = 0;
      const tick = () => {
        if (turn.cancelled) return;
        if (i < words.length) {
          say([words[i++]]);
          setTimeout(tick, text.includes("SLOW") ? 100 : 0);
        } else {
          if (turn.steers.length > 0) say([`(steered: ${turn.steers.join("; ")})`]);
          finish("end_turn");
        }
      };
      tick();
      return;
    }
    case "session/cancel": {
      if (activeTurn && activeTurn.sessionId === params.sessionId) {
        const turn = activeTurn;
        turn.cancelled = true;
        activeTurn = undefined;
        out({ jsonrpc: "2.0", id: turn.id, result: { stopReason: "cancelled" } });
      }
      return; // a notification: no reply
    }
    case "mcode/session/steer": {
      if (!activeTurn || activeTurn.sessionId !== params.sessionId) {
        return refuse(-32602, "Invalid params: Steering requires an admitted, active ACP prompt Turn for this Session.");
      }
      const key = params.clientRequestId ?? Math.random().toString(16);
      if (steerSeen.has(key)) return reply({ turnId: activeTurn.turnId, mode: "duplicate" });
      steerSeen.add(key);
      activeTurn.steers.push(params.text);
      reply({ turnId: activeTurn.turnId, mode: "steered" });
      return;
    }
    case "session/close":
      reply({});
      return;
    default:
      refuse(-32601, `Method not found: ${method}`);
  }
});
