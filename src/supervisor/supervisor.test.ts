/** The standalone supervisor (INV-1518): five tools, woken only by change, refused by the door's rules, recorded without secrets. */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { TaskStore } from "../host/tasks.ts";
import { doorClient } from "../watchdog/client.ts";
import { handleMcpRequest, mintMcpToken, principalForToken } from "../web/mcp-server.ts";
import { mcpServerTools } from "../web/mcp-tools.ts";
import { ChangeFeed } from "../web/mcp-watch.ts";
import { SUPERVISOR_TOOLS, Supervisor } from "./loop.ts";
import type { ModelAsk, ModelTurn } from "./openai.ts";

async function door() {
  const board = new TaskStore(null);
  const feed = new ChangeFeed();
  board.onChange(task => feed.record(task));
  const token = mintMcpToken("p1", "supervisor");
  const agent = { id: "a1", profile: { name: "Ada" } };
  const tools = mcpServerTools({
    registry: { tryGet: () => agent, resolve: () => agent, list: () => [agent], contextMode: () => "normal" } as never,
    orchestrator: { tasks: board, contextBlockers: () => [], prompt: async () => {}, ensureDefaultAgent: () => agent } as never,
    principals: { resolve: id => ({ name: id }) }, workDir: "/w", log: () => {}, listen: () => () => {},
    mayDrive: () => true, changeFeed: feed,
  });
  const server: Server = createServer((req, res) => void handleMcpRequest(req, res, { tools, principalFor: presented => principalForToken(presented, [token]), log: () => {} }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { board, token: token.token, client: doorClient(url, token.token), stop: () => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); } };
}

/** A model that plays a script: each step sees the request and returns calls or a line. */
function scripted(steps: ((request: Parameters<ModelAsk>[0]) => Partial<ModelTurn>)[]): { ask: ModelAsk; requests: Parameters<ModelAsk>[0][] } {
  const requests: Parameters<ModelAsk>[0][] = [];
  let n = 0;
  const ask: ModelAsk = async request => {
    requests.push(request);
    const step = steps[n++];
    if (step === undefined) throw new Error("the model was asked more than scripted");
    const turn = step(request);
    return { id: `resp_${n}`, calls: turn.calls ?? [], text: turn.text ?? "", usage: { input: 100, output: 10, reasoning: 0 } };
  };
  return { ask, requests };
}

test("start, stay quiet while nothing moves, wake on the system's stop, be refused a resume, flag it, and end when the goal completes", async () => {
  const d = await door();
  try {
    const call = (name: string, args: Record<string, unknown>) => ({ callId: `c-${name}`, name, arguments: args });
    let goalId = "";
    const { ask, requests } = scripted([
      () => ({ calls: [call("goal_start", { objective: "Ship the digest", budget: 2000, agent: "coordinator" })] }),
      request => {
        goalId = /^(t\d+)/.exec((request.input[0] as { output: string }).output)?.[1] ?? "";
        setTimeout(() => d.board.setPursuit(goalId, p => ({ ...p, status: "paused", pausedReason: "budget" }), "budget reached"), 30);
        return { text: "Started; watching." };
      },
      request => {
        assert.match((request.input[0] as { content: string }).content, /goal paused \(budget\)/, "woken by the stop, with the record");
        return { calls: [call("goal_control", { task_id: goalId, action: "resume" })] };
      },
      request => {
        assert.match((request.input[0] as { output: string }).output, /REFUSED by the door: .*system/);
        return { calls: [call("raise_attention", { task_id: goalId, note: "budget reached with the summary unsent; a person decides whether to fund more" })] };
      },
      () => {
        setTimeout(() => d.board.setPursuit(goalId, p => ({ ...p, status: "complete" }), "verified"), 30);
        return { text: "Flagged." };
      },
    ]);
    const records: Record<string, unknown>[] = [];
    const supervisor = new Supervisor({ door: d.client, ask, record: entry => records.push(entry), log: () => {}, runId: "r1", watchSeconds: 1 });
    const result = await supervisor.run("Ship the digest", { budget: 5000 });
    assert.equal(result.outcome, "completed");
    assert.equal(result.goalId, goalId);
    assert.equal(result.modelCalls, 5, "two wakes' worth of calls; none while nothing moved");
    assert.deepEqual(requests[0]!.tools.map(tool => tool.name), [...SUPERVISOR_TOOLS], "five tools: no hands, and no watch — the host watches");
    assert.ok(requests[0]!.tools.every(tool => !("idempotency_key" in ((tool.parameters.properties ?? {}) as Record<string, unknown>))), "the host fills the key, the model never sees it");
    const startSchema = requests[0]!.tools.find(tool => tool.name === "goal_start")!.parameters.properties as Record<string, unknown>;
    assert.deepEqual(Object.keys(startSchema), ["objective"], "agent and budget are the operator's, not the model's");
    assert.equal(d.board.get(goalId)!.pursuit?.limits.budget, 5000, "the operator's --budget reached the goal");
    assert.ok(result.refusals.some(refusal => /goal_control: .*system/.test(refusal)));
    assert.equal(d.board.get(goalId)!.flag?.by, "p1", "the flag is in the token holder's name");
    assert.deepEqual(result.toolCalls, { goal_start: 1, goal_control: 1, raise_attention: 1 });
    const transcript = records.map(entry => JSON.stringify(entry)).join("\n");
    assert.ok(!transcript.includes(d.token), "the door's token is never in the transcript");
    assert.deepEqual([records[0]!.kind, records.at(-1)!.kind], ["start", "end"]);
  } finally {
    await d.stop();
  }
});

test("one goal per run, only its five tools, and the call limit ends the run", async () => {
  const d = await door();
  try {
    const call = (name: string, args: Record<string, unknown>, id: string) => ({ callId: id, name, arguments: args });
    const { ask } = scripted([
      () => ({ calls: [call("goal_start", { objective: "A" }, "1"), call("goal_start", { objective: "B" }, "2"), call("run_on_box", { command: "rm -rf /" }, "3")] }),
      request => {
        const outputs = request.input.map(item => (item as { output: string }).output);
        assert.match(outputs[1]!, /already started t\d+; one goal per run/);
        assert.match(outputs[2]!, /run_on_box is not one of your tools/);
        return { text: "ok" };
      },
    ]);
    const supervisor = new Supervisor({ door: d.client, ask, record: () => {}, log: () => {}, runId: "r2", watchSeconds: 0, limits: { maxModelCalls: 2 } });
    const result = await supervisor.run("A");
    assert.equal(result.outcome, "limit_calls");
    assert.equal(d.board.list().filter(task => task.pursuit !== undefined).length, 1, "one goal on the board");
    assert.equal(result.refusals.length, 2);
  } finally {
    await d.stop();
  }
});

test("a model that never starts the goal ends the run as no_goal", async () => {
  const d = await door();
  try {
    const { ask } = scripted([() => ({ text: "I would rather not." })]);
    const result = await new Supervisor({ door: d.client, ask, record: () => {}, log: () => {}, runId: "r3" }).run("A");
    assert.equal(result.outcome, "no_goal");
    assert.equal(result.modelCalls, 1);
  } finally {
    await d.stop();
  }
});
