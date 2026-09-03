/**
 * The import loop through the orchestrator, which is where the claim has to hold: the host
 * creates the agent from the profile alone, the new bot writes its own skills and memories
 * in its first turn, and what the host says landed is what landed (docs/29 §5).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentRegistry } from "../agents/registry.ts";
import type { BoxClient } from "../box/client.ts";
import { Orchestrator } from "./orchestrator.ts";
import { parseSkillFile } from "./skills.ts";
import { SkillProvenance } from "./skill-provenance.ts";
import { fakeModel } from "./testing/fake-model.ts";
import { type BotTemplate, TEMPLATE_CUE, TEMPLATE_FORMAT, generaliseRoutine } from "./template.ts";
import { reviewInputFor } from "./turn.ts";

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

const toolUse = (id: string, name: string, input: Record<string, unknown>): Anthropic.ContentBlock =>
  ({ type: "tool_use", id, name, input }) as Anthropic.ContentBlock;
const text = (content: string): Anthropic.ContentBlock => ({ type: "text", text: content, citations: null }) as Anthropic.ContentBlock;

/** A box that is a map of files. Everything else the turn might ask of it answers blandly. */
function fakeBox(files: Map<string, string>): BoxClient {
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
    ensureDisplay: async () => ({ display: 1 }),
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
      if (names.size === 0 && !files.has(path)) throw new Error(`${path} does not exist`);
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

const ROUTINE = generaliseRoutine(
  "---\nname: Weekly digest\ndescription: Monday digest.\nschedule: \"0 9 * * 1\"\ndeliver: feishu:oc_abcdef123456\nagent: Ada\n---\nPost the week to feishu:oc_abcdef123456.\n",
  { self: "Ada" }
);

const TEMPLATE: BotTemplate = {
  format: TEMPLATE_FORMAT,
  profile: { name: "下载专家", title: "转写", description: "Turns videos into Chinese transcripts.", tools: "desk" },
  memory: [{ kind: "fact", text: "Transcripts are written to ~/work/out as markdown." }],
  skills: [{ slug: "transcribe", name: "音视频转写", description: "Transcribe a video.", files: { "SKILL.md": "---\nname: 音视频转写\ndescription: Transcribe a video.\n---\nFetch, transcribe, write to ~/work/out.\n" } }],
  routines: [{ slug: "weekly-digest", name: "Weekly digest", description: "Monday digest.", files: { "SKILL.md": ROUTINE.text }, fillIns: ROUTINE.fillIns }],
  connectors: ["feishu"],
  meta: { createdBy: "kin" },
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentbox-tpl-import-"));
  process.env.AGENTBOX_HOME = root;
  // The suite runs without credentials; the fake model needs a provider profile to exist.
  process.env.ANTHROPIC_API_KEY = "test-key";
  const registry = new AgentRegistry(join(root, "agents"));
  const files = new Map<string, string>();
  return {
    root,
    registry,
    files,
    provenance: new SkillProvenance(join(root, "skill-provenance.jsonl")),
    cleanup: () => {
      delete process.env.AGENTBOX_HOME;
      delete process.env.ANTHROPIC_API_KEY;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("an imported bot installs its own recipe on its first turn, and the host reports what landed", async () => {
  const { registry, files, provenance, cleanup } = fixture();
  try {
    let cue = "";
    let offered: string[] = [];
    const client = fakeModel(({ index, params }) => {
      if (index === 0) {
        const last = params.messages[params.messages.length - 1];
        cue = typeof last?.content === "string" ? last.content : "";
        offered = (params.tools ?? []).map(tool => (tool as { name: string }).name);
        return message(
          [
            // What the bot copies out of the recipe: the skill as given, the routine as given
            // but *without* paused (the bot forgot), and the memory.
            toolUse("t1", "write_file", { path: "/home/box/work/skills/transcribe/SKILL.md", content: TEMPLATE.skills[0]!.files["SKILL.md"] }),
            toolUse("t2", "write_file", { path: "/home/box/work/skills/weekly-digest/SKILL.md", content: ROUTINE.text.replace("agent: {self}", "agent: 下载专家") }),
            toolUse("t3", "RememberFact", { fact: "Transcripts are written to ~/work/out as markdown." }),
          ],
          "tool_use"
        );
      }
      return message([text("你好，我是下载专家。先问一句：周报要发到哪个飞书群？")]);
    });
    const orchestrator = new Orchestrator({
      registry,
      client,
      useBox: true,
      boxClient: fakeBox(files),
      inbox: null,
      turns: null,
      skillProvenance: provenance,
      hooks: null,
      claims: null,
      tasks: null,
      scopes: null,
      mcp: null,
    });
    assert.equal((await orchestrator.connectBox()).connected, true);

    const lines: string[] = [];
    const imported = orchestrator.importTemplate(TEMPLATE, { caller: { userId: "chris" }, connected: ["browser"], log: line => lines.push(line) });
    assert.equal(imported.agent.profile.name, "下载专家");
    assert.equal(imported.agent.profile.title, "转写");
    assert.deepEqual(imported.agent.profile.tools?.slice(0, 2), ["bash", "Jobs"], "the tier became a tool list");
    assert.equal(imported.agent.profile.importedFrom?.name, "下载专家");
    assert.equal(imported.agent.profile.importedFrom?.createdBy, "kin");
    assert.deepEqual(imported.pending.connectors, ["feishu"]);
    assert.deepEqual(imported.pending.fillIns.map(fillIn => fillIn.id), ["feishu_chat", "timezone"]);

    const result = await imported.settled;
    assert.ok(result !== undefined, lines.join("\n"));

    // The recipe was placed for the bot, with its own name in place of {self}.
    const recipe = files.get("/home/box/work/templates/下载专家/recipe.md") ?? files.get(`/home/box/work/templates/${[...files.keys()].find(key => key.startsWith("/home/box/work/templates/"))?.split("/")[5]}/recipe.md`);
    assert.ok(recipe !== undefined, [...files.keys()].join(", "));
    assert.match(recipe, /agent: 下载专家/);
    assert.match(recipe, /deliver: \{feishu_chat\}/);

    // The cue told it what to do and where, and lands on the classifier's untrusted side.
    assert.ok(cue.startsWith(TEMPLATE_CUE), cue.slice(0, 80));
    assert.match(cue, /from the template "下载专家" by kin/);
    assert.match(cue, /one at a time: Feishu chat to deliver to; Timezone; feishu is not connected here/);
    // The setup turn held files and memory and a way to ask, and nothing that reaches out.
    assert.ok(offered.includes("write_file") && offered.includes("RememberFact") && offered.includes("AskUser"), offered.join(","));
    for (const tool of ["bash", "SendToAgent", "Delegate", "browser_open", "WebFetch", "computer", "CreateAgent"]) {
      assert.ok(!offered.includes(tool), `${tool} was offered in a setup turn`);
    }
    const review = reviewInputFor({ agentName: "下载专家", inbound: [{ fromId: "user", fromName: "you", text: cue } as never], transcript: [], messages: [], tool: "bash", input: {}, why: "" });
    assert.deepEqual(review.trusted, []);
    assert.equal(review.untrusted[0], cue);

    // The bot's own writes are what landed — and the routine it wrote unpaused was paused by the
    // host on the way in, with the template named as its origin.
    const routine = parseSkillFile(files.get("/home/box/work/skills/weekly-digest/SKILL.md")!).meta;
    assert.equal(routine.paused, "true");
    assert.equal(routine.authored_by, `template:${imported.id}`);
    assert.equal(routine.agent, "下载专家");
    assert.equal(parseSkillFile(files.get("/home/box/work/skills/transcribe/SKILL.md")!).meta.paused, undefined);

    // Provenance is true, not forged: the host saw the new bot write the file.
    assert.equal(provenance.writerOf("weekly-digest")?.agentId, imported.agent.id);
    assert.equal(provenance.writerOf("weekly-digest")?.tool, "write_file");

    // The memory says where it came from and is about nobody.
    const [record] = registry.readMemoryRecords(imported.agent.id);
    assert.equal(record?.source, `template:${imported.id}`);
    assert.equal(record?.about, undefined);

    assert.equal(result.summary, "Added 下载专家: 1 skill, 1 memory, 1 routine (paused).");
    assert.deepEqual(result.unpaused, [], "stamped on write, so nothing was left to correct");
    const ledger = readFileSync(join(process.env.AGENTBOX_HOME!, "template-imports.jsonl"), "utf8");
    assert.match(ledger, /"summary":"Added 下载专家/);
  } finally {
    cleanup();
  }
});

test("a setup turn that installs only part of the recipe is reported as such, and a taken name is refused", async () => {
  const { registry, files, provenance, cleanup } = fixture();
  try {
    const client = fakeModel(({ index }) =>
      index === 0
        ? message([toolUse("t1", "write_file", { path: "/home/box/work/skills/transcribe/SKILL.md", content: TEMPLATE.skills[0]!.files["SKILL.md"] })], "tool_use")
        : message([text("Hello.")])
    );
    const orchestrator = new Orchestrator({ registry, client, useBox: true, boxClient: fakeBox(files), inbox: null, turns: null, skillProvenance: provenance, hooks: null, claims: null, tasks: null, scopes: null, mcp: null });
    await orchestrator.connectBox();
    const imported = orchestrator.importTemplate(TEMPLATE, { connected: [], log: () => undefined });
    const result = await imported.settled;
    assert.equal(result?.summary, "Added 下载专家, but not all of it: missing routines weekly-digest; 1 memory.");
    assert.deepEqual(result?.missing.routines, ["weekly-digest"]);

    assert.throws(() => orchestrator.importTemplate(TEMPLATE, { log: () => undefined }), /already exists here; pass another name/);
    const renamed = orchestrator.importTemplate(TEMPLATE, { name: "下载专家 2", log: () => undefined });
    assert.equal(renamed.agent.profile.name, "下载专家 2");
    await renamed.settled;
  } finally {
    cleanup();
  }
});
