/**
 * Two boxes through the orchestrator (docs/30 §4 Stage A): an agent's write lands in its own
 * box, its prompt lists its own box's skills, a scheduled skill on the attached box runs as an
 * agent of that box, and the memory mirror follows the agent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentRegistry } from "../agents/registry.ts";
import type { BoxClient } from "../box/client.ts";
import { attachedBox } from "../box/boxes.ts";
import { Orchestrator } from "./orchestrator.ts";
import { SkillProvenance } from "./skill-provenance.ts";
import { fakeModel } from "./testing/fake-model.ts";

function message(content: Anthropic.ContentBlock[], stopReason: Anthropic.Message["stop_reason"] = "end_turn"): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}
const toolUse = (id: string, name: string, input: Record<string, unknown>): Anthropic.ContentBlock => ({ type: "tool_use", id, name, input }) as Anthropic.ContentBlock;
const text = (content: string): Anthropic.ContentBlock => ({ type: "text", text: content, citations: null }) as Anthropic.ContentBlock;

/** A box that is a map of files and remembers which desktops it was asked for. */
function fakeBox(files: Map<string, string>, displays: number[]): BoxClient {
  const entriesUnder = (path: string) => {
    const names = new Map<string, string>();
    for (const key of files.keys()) {
      if (!key.startsWith(`${path}/`)) continue;
      const rest = key.slice(path.length + 1);
      names.set(rest.split("/")[0]!, rest.includes("/") ? "directory" : "file");
    }
    return names;
  };
  const box = {
    health: async () => ({ ok: true, resolution: undefined }),
    ensureDisplay: async (index: number) => {
      displays.push(index);
      return { display: index };
    },
    exec: async () => ({ stdout: "", stderr: "", exit_code: 0 }),
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
      return { path, bytes_written: content.length };
    },
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`${path} does not exist`);
      return { path, content, total_lines: content.split("\n").length, truncated: false };
    },
    listDir: async (path: string) => {
      const names = entriesUnder(path);
      if (names.size === 0) throw new Error(`${path} does not exist`);
      return { path, entries: [...names].map(([name, type]) => ({ name, type, size: 0 })) };
    },
    uploadFile: async (path: string, base64: string) => {
      files.set(path, Buffer.from(base64, "base64").toString("utf8"));
      return { path };
    },
  };
  return new Proxy(box, {
    get: (target, property) => (property in target ? target[property as keyof typeof target] : async () => ({})),
  }) as unknown as BoxClient;
}

test("two boxes: files, skills, desktops and memory follow the agent's box; a schedule runs where its file is", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-multibox-"));
  process.env.AGENTBOX_HOME = root;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const registry = new AgentRegistry(join(root, "agents"));
    const tokenFile = join(root, "grok.token");
    writeFileSync(tokenFile, "t\n");
    const grok = registry.attachBox(attachedBox({ name: "grok", baseUrl: "http://127.0.0.1:1", tokenFile, displayFloor: 10 }));
    const ada = registry.create({ name: "Ada" });
    const vera = registry.create({ name: "Vera", boxId: grok.id });

    const ownFiles = new Map<string, string>([["/home/box/work/skills/own-only/SKILL.md", "---\nname: Own only\ndescription: on the own box\n---\nbody\n"]]);
    const grokFiles = new Map<string, string>([
      ["/home/box/work/skills/grok-only/SKILL.md", "---\nname: Grok only\ndescription: on the grok box\n---\nbody\n"],
      ["/home/box/work/skills/digest/SKILL.md", "---\nname: Digest\ndescription: d\nschedule: \"@every 1m\"\n---\nbody\n"],
    ]);
    const ownDisplays: number[] = [];
    const grokDisplays: number[] = [];
    let grokHealthy = true;
    const seenSkills: string[] = [];
    const events: string[] = [];

    const client = fakeModel(({ params }) => {
      // A fresh turn (the person's text is the last message) gets the tool calls; the round
      // after the tool results ends it. Per turn, not per client, because there are two turns.
      const last = params.messages[params.messages.length - 1];
      if (last?.role === "user" && typeof last.content === "string") {
        const system = typeof params.system === "string" ? params.system : (params.system ?? []).map(block => ("text" in block ? block.text : "")).join("\n");
        seenSkills.push(system);
        return message([toolUse("t1", "write_file", { path: "/home/box/work/note.md", content: "hello from my own box" }), toolUse("t2", "RememberFact", { fact: "The transcripts live under ~/work/out on this machine." })], "tool_use");
      }
      return message([text("done")]);
    });
    const orchestrator = new Orchestrator({
      registry,
      client,
      useBox: true,
      boxClient: fakeBox(ownFiles, ownDisplays),
      boxClientFor: entry => {
        if (entry.id !== grok.id) return undefined;
        if (!grokHealthy) return undefined;
        const box = fakeBox(grokFiles, grokDisplays);
        return new Proxy(box, {
          get: (target, property) =>
            property === "health"
              ? async () => {
                  if (!grokHealthy) throw new Error("connection refused");
                  return { ok: true, resolution: undefined };
                }
              : target[property as keyof typeof target],
        }) as unknown as BoxClient;
      },
      inbox: null,
      turns: null,
      skillProvenance: new SkillProvenance(join(root, "prov.jsonl")),
      hooks: null,
      claims: null,
      tasks: null,
      scopes: null,
      mcp: null,
      onBusEvent: event => events.push(JSON.stringify(event).slice(0, 300)),
      onTurnEvent: event => events.push(JSON.stringify(event).slice(0, 300)),
    });
    assert.equal((await orchestrator.connectBox()).connected, true);
    assert.deepEqual(orchestrator.boxStatus().map(status => [status.name, status.connected, status.agents]), [[registry.box.name, true, 1], ["grok", true, 1]]);

    // Vera's turn: her write and her memory land on grok; her prompt lists grok's skills only.
    await orchestrator.prompt(vera.id, "hi");
    assert.equal(grokFiles.get("/home/box/work/note.md"), "hello from my own box", `grok: ${[...grokFiles.keys()].join(",")} own: ${[...ownFiles.keys()].join(",")} events: ${events.join(" | ")}`);
    assert.equal(ownFiles.has("/home/box/work/note.md"), false, "nothing crossed to the own box");
    assert.deepEqual(grokDisplays, [10], "her desktop is grok's :10");
    assert.deepEqual(ownDisplays, []);
    assert.match(seenSkills[0]!, /Grok only/);
    assert.doesNotMatch(seenSkills[0]!, /Own only/);
    assert.equal([...grokFiles.keys()].some(key => key.startsWith("/home/box/work/memory/vera/")), true, "the mirror followed her");
    assert.equal([...ownFiles.keys()].some(key => key.startsWith("/home/box/work/memory/vera/")), false);

    // Ada's turn is on the own box, with the own box's skills and desktop 1.
    await orchestrator.prompt(ada.id, "hi");
    assert.equal(ownFiles.get("/home/box/work/note.md"), "hello from my own box");
    assert.deepEqual(ownDisplays, [1]);
    assert.match(seenSkills[1]!, /Own only/);
    assert.doesNotMatch(seenSkills[1]!, /Grok only/);

    // The scheduler sees both boxes' skills and sends grok's to an agent of grok.
    const scheduled = await orchestrator.scheduler.status();
    const digest = scheduled.find(entry => entry.slug === "digest");
    assert.ok(digest !== undefined, JSON.stringify(scheduled));
    const runs: string[] = [];
    const original = orchestrator.prompt.bind(orchestrator);
    (orchestrator as unknown as { prompt: typeof original }).prompt = async (agent: string, promptText: string, caller?: { userId?: string }, options?: Parameters<typeof original>[3]) => {
      runs.push(registry.resolve(agent).profile.name);
      return original(agent, promptText, caller, options);
    };
    const fired = await orchestrator.scheduler.runNow("digest");
    assert.ok(fired.ok, JSON.stringify(fired));
    await orchestrator.settle();
    assert.deepEqual(runs, ["Vera"], "the routine on grok ran as grok's agent, not as Ada");

    // Detaching with a resident is refused; the box stays reachable.
    assert.throws(() => orchestrator.detachBox("grok"), /live in grok/);
    assert.equal(orchestrator.boxClient(vera.id) !== undefined, true);

    // The watchdog: a box that stops answering is dropped and announced once, dialled again
    // each tick, and announced once more when it is back.
    grokHealthy = false;
    const down = await orchestrator.checkAttachedBoxes();
    assert.deepEqual(down.map(change => [change.name, change.connected]), [["grok", false]]);
    assert.equal(orchestrator.boxClient(vera.id), undefined, "its agents have no box while it is down");
    assert.deepEqual(await orchestrator.checkAttachedBoxes(), [], "still down: nothing new to say");
    grokHealthy = true;
    const back = await orchestrator.checkAttachedBoxes();
    assert.deepEqual(back.map(change => [change.name, change.connected]), [["grok", true]]);
    assert.equal(orchestrator.boxClient(vera.id) !== undefined, true);
  } finally {
    delete process.env.AGENTBOX_HOME;
    delete process.env.ANTHROPIC_API_KEY;
    rmSync(root, { recursive: true, force: true });
  }
});
