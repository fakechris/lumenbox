/**
 * The organisation's skill library and its place in every box (INV-2222, docs/109 §6): published
 * once, read in every box, updated and withdrawn everywhere, read-only as far as the platform
 * allows, and nothing at all on a personal installation.
 *
 * The boxes here are directories on this machine behind the box client's own calls, and the
 * commands the host sends are run by a real shell, so the modes asserted are the modes `chmod` set.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentRegistry } from "../agents/registry.ts";
import { attachedBox } from "../box/boxes.ts";
import type { BoxClient } from "../box/client.ts";
import { DOCKER_WORK, orgSkillsDir } from "./box-paths.ts";
import type { InstallationMode } from "./installation.ts";
import { Orchestrator } from "./orchestrator.ts";
import { attachOrgSkills } from "./org-skill-sync.ts";
import { ORG_SKILLS_LEDGER, OrgSkills } from "./org-skills.ts";
import { skillWriteRefusal } from "./skill-contract.ts";
import { loadSkills, renderSkills, type Skill, SKILL_INDEX_CHARS } from "./skills.ts";
import { fakeModel } from "./testing/fake-model.ts";

const ROOT = orgSkillsDir(undefined);
const skillText = (name: string, description: string, body = "Do the thing.") => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
const DWS = { "SKILL.md": skillText("DingTalk CLI", "Use when the person asks for anything in DingTalk: install the command-line tool and sign in as them."), "scripts/install.sh": "#!/bin/sh\necho install\n" };

/** A box that is a directory here: `/home/box/work` is `dir`, and a command is run by a real shell with that path put in. */
function diskBox(dir: string, state: { up: boolean } = { up: true }): BoxClient {
  const at = (path: string) => {
    if (!state.up) throw new Error("connection refused");
    if (path !== DOCKER_WORK && !path.startsWith(`${DOCKER_WORK}/`)) throw new Error(`${path} is outside the work directory`);
    return join(dir, path.slice(DOCKER_WORK.length));
  };
  const box = {
    health: async () => {
      at(DOCKER_WORK);
      return { ok: true, resolution: undefined };
    },
    exec: async (command: string) => {
      at(DOCKER_WORK);
      try {
        execSync(command.replaceAll(DOCKER_WORK, dir), { stdio: "pipe", shell: "/bin/sh" });
        return { stdout: "", stderr: "", exit_code: 0, timed_out: false };
      } catch (error) {
        return { stdout: "", stderr: String((error as { stderr?: Buffer }).stderr ?? error), exit_code: 1, timed_out: false };
      }
    },
    writeFile: async (path: string, content: string) => {
      mkdirSync(dirname(at(path)), { recursive: true });
      writeFileSync(at(path), content);
      return { path, bytes_written: content.length };
    },
    readFile: async (path: string) => {
      const content = readFileSync(at(path), "utf8");
      return { path, content, total_lines: content.split("\n").length, truncated: false };
    },
    downloadFile: async (path: string) => ({ path, size: 0, media_type: "text/plain", base64: readFileSync(at(path)).toString("base64") }),
    listDir: async (path: string) => ({
      path,
      entries: readdirSync(at(path)).map(name => ({ name, type: statSync(join(at(path), name)).isDirectory() ? "directory" : "file", size: 0 })),
    }),
  };
  return new Proxy(box, { get: (target, property) => (property in target ? target[property as keyof typeof target] : async () => ({})) }) as unknown as BoxClient;
}

function message(content: Anthropic.ContentBlock[], stopReason: Anthropic.Message["stop_reason"] = "end_turn"): Anthropic.Message {
  return {
    id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5", content, stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

test("published once: two boxes' agents list it and read it; an update and a withdrawal reach both; a box that was down gets it when it connects; a change from inside is refused and written over", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-org-skills-"));
  process.env.AGENTBOX_HOME = home;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const registry = new AgentRegistry(join(home, "agents"));
    writeFileSync(join(home, "ann.token"), "t\n");
    const annBox = registry.attachBox(attachedBox({ name: "ann", baseUrl: "http://127.0.0.1:1", tokenFile: join(home, "ann.token"), displayFloor: 10 }));
    const ada = registry.create({ name: "Ada" });
    const vera = registry.create({ name: "Vera", boxId: annBox.id });
    const dirs = { own: join(home, "box-own"), ann: join(home, "box-ann") };
    for (const dir of Object.values(dirs)) {
      mkdirSync(join(dir, "skills", "own-notes"), { recursive: true });
      writeFileSync(join(dir, "skills", "own-notes", "SKILL.md"), skillText("Own notes", "Use when asked for this box's notes."));
    }
    const annUp = { up: false };
    const annClient = diskBox(dirs.ann, annUp);

    // Each turn's first request is kept (what the agent was sent) and answered by reading the organisation's skill.
    const prompts: string[] = [], reads: string[] = [];
    const client = fakeModel(({ params }) => {
      const last = params.messages[params.messages.length - 1];
      if (last?.role === "user" && typeof last.content === "string") {
        prompts.push(typeof params.system === "string" ? params.system : (params.system ?? []).map(block => ("text" in block ? block.text : "")).join("\n"));
        return message([{ type: "tool_use", id: "t1", name: "read_file", input: { path: `${ROOT}/dingtalk-cli/SKILL.md` } } as Anthropic.ContentBlock], "tool_use");
      }
      reads.push(JSON.stringify(last?.content));
      return message([{ type: "text", text: "done", citations: null } as Anthropic.ContentBlock]);
    });
    const orchestrator = new Orchestrator({
      registry, client, useBox: true, boxClient: diskBox(dirs.own), boxClientFor: entry => (entry.id === annBox.id && annUp.up ? annClient : undefined),
      inbox: null, turns: null, hooks: null, claims: null, tasks: null, scopes: null, mcp: null,
    });
    const library = new OrgSkills(home, { mode: () => "organisation" });
    const logged: string[] = [];
    const sync = attachOrgSkills(orchestrator, library, line => logged.push(line));
    await sync.syncDue(); // nothing is connected yet: a pass with nobody to sync ends, and the next one still runs
    await orchestrator.connectBox();
    await sync.syncDue();
    assert.equal(existsSync(join(dirs.own, ".lumenbox", "org-skills")), false, "an organisation with no skills places no directory");

    // Published once, by an Admin.
    const published = library.publish("dingtalk-cli", DWS, "p-admin", "upload");
    assert.equal(published.ok, true, JSON.stringify(published));
    await sync.syncDue();
    assert.equal(readFileSync(join(dirs.own, ".lumenbox", "org-skills", "dingtalk-cli", "SKILL.md"), "utf8"), DWS["SKILL.md"]);
    assert.deepEqual(sync.status().map(status => status.state), ["current", "offline"], "a box that is down is not synced, and is said to be offline");
    assert.equal(existsSync(join(dirs.ann, ".lumenbox")), false);

    // The box that was down connects: it is synced then, with nothing else asked of anybody.
    annUp.up = true;
    assert.equal((await orchestrator.reconnectBox(registry.boxById(annBox.id)!)).connected, true);
    await sync.syncDue();
    assert.deepEqual(sync.status().map(status => status.state), ["current", "current"]);
    assert.equal(readFileSync(join(dirs.ann, ".lumenbox", "org-skills", "dingtalk-cli", "scripts", "install.sh"), "utf8"), DWS["scripts/install.sh"]);

    // Both boxes' agents are told of it, and can read it.
    for (const agent of [ada, vera]) await orchestrator.prompt(agent.id, "hi");
    for (const prompt of prompts) {
      assert.match(prompt, /\*\*DingTalk CLI\*\* — Use when the person asks for anything in DingTalk/);
      assert.ok(prompt.includes(`\`${ROOT}/dingtalk-cli/SKILL.md\``), "with the path it is read at");
      assert.match(prompt, /are the organisation's: the same in every box and read-only here/);
      assert.match(prompt, /\*\*Own notes\*\*/, "the box's own skills are listed beside it");
    }
    assert.equal(prompts.length, 2);
    assert.equal(reads.length, 2);
    for (const read of reads) assert.match(read, /install the command-line tool and sign in as them/, "the skill's text reached the agent that read it");

    // Read-only, as far as this platform goes: the modes are closed, a write is refused, and what is changed anyway is written over and reported.
    const placed = join(dirs.ann, ".lumenbox", "org-skills", "dingtalk-cli", "SKILL.md");
    assert.equal(statSync(placed).mode & 0o222, 0, "no write bit on a placed file");
    assert.equal(statSync(dirname(placed)).mode & 0o222, 0, "no write bit on its directory");
    // The box's own user is refused by the mode; root is refused by nothing, so there the test says only what is true of it.
    if (process.getuid?.() !== 0) await assert.rejects(annClient.writeFile(`${ROOT}/dingtalk-cli/SKILL.md`, "changed from inside"), /EACCES|EPERM/);
    assert.match((await skillWriteRefusal(annClient, `${ROOT}/dingtalk-cli/SKILL.md`, "x")) ?? "", /one of the organisation's skills: read-only/, "an agent's write_file is refused by the host before it reaches the box");
    assert.equal(await skillWriteRefusal(annClient, `${DOCKER_WORK}/skills/own-notes/SKILL.md`, skillText("Own notes", "Use when asked.")), undefined, "the box's own skills are written as before");
    // Somebody opens the mode on purpose (the box's user can: the daemon is that user) and changes it.
    execSync(`chmod -R u+w '${join(dirs.ann, ".lumenbox", "org-skills")}'`);
    writeFileSync(placed, "changed from inside");
    writeFileSync(join(dirname(placed), "extra.md"), "added from inside");
    const after = await sync.syncBox(annBox.id);
    assert.equal(readFileSync(placed, "utf8"), DWS["SKILL.md"], "written over at the next sync");
    assert.equal(existsSync(join(dirname(placed), "extra.md")), false);
    assert.deepEqual(after.drift.sort(), ["dingtalk-cli/SKILL.md", "dingtalk-cli/extra.md"], "and the Admin is told what was changed");
    assert.equal(statSync(placed).mode & 0o222, 0, "closed again");

    // An update reaches both boxes; nothing from inside was changed this time, so nothing is called drift.
    const updated = library.publish("dingtalk-cli", { ...DWS, "SKILL.md": skillText("DingTalk CLI", "Use when the person asks for anything in DingTalk.", "Version two.") }, "p-admin", "upload");
    assert.equal(updated.ok && updated.skill.version, 2);
    await sync.syncDue();
    for (const dir of Object.values(dirs)) assert.match(readFileSync(join(dir, ".lumenbox", "org-skills", "dingtalk-cli", "SKILL.md"), "utf8"), /Version two\./);
    assert.deepEqual(sync.status().flatMap(status => status.drift), []);

    // Withdrawn: gone from both, and from what their agents are told.
    assert.equal(library.withdraw("dingtalk-cli", "p-admin").ok, true);
    await sync.syncDue();
    for (const dir of Object.values(dirs)) assert.equal(existsSync(join(dir, ".lumenbox", "org-skills")), false, "the last skill withdrawn takes the directory with it");
    for (const box of [registry.box.id, annBox.id]) {
      const { skills } = await orchestrator.skillsFor(box).refresh(true);
      assert.deepEqual(skills.map(skill => skill.slug), ["own-notes"]);
    }

    // The ledger is the audit: who did what, when, in order; and a restart reads the same library.
    assert.deepEqual(library.acts().map(act => [act.act, act.slug, act.by, act.version ?? null]), [["publish", "dingtalk-cli", "p-admin", 1], ["update", "dingtalk-cli", "p-admin", 2], ["withdraw", "dingtalk-cli", "p-admin", null]]);
    assert.equal(readFileSync(join(home, ORG_SKILLS_LEDGER), "utf8").trim().split("\n").length, 3);
    assert.equal(library.publish("dingtalk-cli", DWS, "p-admin", "upload").ok && library.get("dingtalk-cli")!.version, 3, "published again after a withdrawal, the versions go on");
    assert.deepEqual(new OrgSkills(home, { mode: () => "organisation" }).list(), library.list());
    assert.deepEqual(library.filesOf(library.get("dingtalk-cli")!), DWS);
  } finally {
    execSync(`chmod -R u+w '${home}'`);
    rmSync(home, { recursive: true, force: true });
  }
});

test("what is refused at publish: a credential, a routine, an agent's own scope, a description past the limit; and a personal installation has no library and no directory", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-org-skills-"));
  try {
    let mode: InstallationMode = "organisation";
    const library = new OrgSkills(home, { mode: () => mode, held: () => new Map([["DWS_APP_SECRET", "a-value-the-vault-holds-1234"]]) });
    const refused = (files: Record<string, string>, slug = "s") => {
      const result = library.publish(slug, files, "p-admin", "upload");
      return result.ok ? "published" : `${result.code}: ${result.why}`;
    };
    const key = `sk-${"a1B2".repeat(8)}`;
    assert.match(refused({ "SKILL.md": skillText("S", "Use when asked."), "scripts/run.sh": `export KEY=${key}\n` }), /^credential: scripts\/run\.sh holds something shaped like a credential \(openai-anthropic\)/);
    assert.doesNotMatch(refused({ "SKILL.md": skillText("S", "Use when asked.", key) }), new RegExp(key), "the refusal never repeats the credential");
    assert.match(refused({ "SKILL.md": skillText("S", "Use when asked.", "call it with a-value-the-vault-holds-1234") }), /^credential: SKILL\.md holds the value of DWS_APP_SECRET/);
    assert.match(refused({ "SKILL.md": "---\nname: S\ndescription: Use when asked.\nschedule: \"@daily\"\n---\n\nbody\n" }), /^invalid: s: it has a schedule or a trigger/);
    assert.match(refused({ "SKILL.md": "---\nname: S\ndescription: Use when asked.\nscope: agent\nowner: Ada\n---\n\nbody\n" }), /^invalid: s: it is `scope: agent`/);
    assert.match(refused({ "SKILL.md": skillText("S", "x".repeat(401)) }), /^invalid: s: the description is 401 characters/);
    assert.match(refused({ "SKILL.md": "---\nname: S\n---\n\nbody\n" }), /^invalid: s: no description/);
    assert.match(refused({ "notes.md": "x" }), /^invalid: There is no SKILL\.md/);
    assert.match(refused({ "SKILL.md": skillText("S", "Use when asked."), "../escape.sh": "x" }), /^invalid: "\.\.\/escape\.sh" is not a path inside the skill/);
    assert.match(refused({ "SKILL.md": skillText("S", "Use when asked.") }, "Bad Slug"), /^invalid: "Bad Slug" cannot be a skill's directory name/);
    assert.equal(existsSync(join(home, ORG_SKILLS_LEDGER)), false, "a refused publish leaves no line");
    assert.equal(refused({ "SKILL.md": skillText("S", "Use when asked.") }), "published");
    assert.match(refused({ "SKILL.md": skillText("S", "Use when asked.") }), /^unchanged: s is already published exactly so \(version 1\)/);

    // A personal installation: no write, nothing listed, no second root, nothing placed.
    mode = "single-machine";
    assert.match(refused({ "SKILL.md": skillText("T", "Use when asked.") }, "t"), /^personal: /);
    assert.equal(library.withdraw("s", "owner").ok, false);
    assert.deepEqual(library.list(), []);
    const dir = join(home, "box");
    mkdirSync(join(dir, "skills", "own-notes"), { recursive: true });
    writeFileSync(join(dir, "skills", "own-notes", "SKILL.md"), skillText("Own notes", "Use when asked for this box's notes."));
    const box = diskBox(dir);
    const host = {
      registry: { listBoxes: () => [{ id: "b1", name: "box" }], boxById: () => undefined },
      boxClientById: () => box, skillsFor: () => ({ refresh: async () => undefined }),
      orgSkillRoot: (_: string): { root: string; required: ReadonlySet<string> } | undefined => ({ root: "unset", required: new Set() }), boxConnected: (_: string): void => {},
    };
    const sync = attachOrgSkills(host, library, () => {});
    await sync.syncDue();
    assert.deepEqual(sync.status(), [], "a personal installation has no box to sync");
    assert.equal(host.orgSkillRoot("b1"), undefined, "and its loader has no second root");
    assert.equal(existsSync(join(dir, ".lumenbox")), false, "and no such directory");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a name both have: a required organisation skill is read and the box's own is not; any other gives way to the box's own; the index says which is read", async () => {
  const files = new Map<string, string>([
    ["/home/box/work/skills/expenses/SKILL.md", skillText("Expenses", "Use when filing expenses, this box's way.")],
    ["/home/box/work/skills/travel/SKILL.md", skillText("Travel", "Use when booking travel, this box's way.")],
    [`${ROOT}/expenses/SKILL.md`, skillText("Expenses", "Use when filing expenses, the organisation's way.")],
    [`${ROOT}/travel/SKILL.md`, skillText("Travel", "Use when booking travel, the organisation's way.")],
    [`${ROOT}/onboarding/SKILL.md`, skillText("Onboarding", "Use when somebody new joins.")],
  ]);
  const source = {
    listDir: async (path: string) => {
      const names = new Map<string, string>();
      for (const key of files.keys()) if (key.startsWith(`${path}/`)) names.set(key.slice(path.length + 1).split("/")[0]!, key.slice(path.length + 1).includes("/") ? "directory" : "file");
      if (names.size === 0) throw new Error("no such directory");
      return { entries: [...names].map(([name, type]) => ({ name, type })) };
    },
    readFile: async (path: string) => {
      if (!files.has(path)) throw new Error("no such file");
      return { content: files.get(path)! };
    },
  };
  const loaded = await loadSkills(source, [], "/home/box/work/skills", { root: ROOT, required: new Set(["expenses"]) });
  const by = (slug: string) => loaded.skills.find(skill => skill.slug === slug)!;
  assert.equal(by("expenses").path, `${ROOT}/expenses/SKILL.md`, "required: the organisation's is read");
  assert.equal(by("travel").path, "/home/box/work/skills/travel/SKILL.md", "not required: the box's own is read, as an installed skill always gave way");
  assert.equal(by("onboarding").origin, "organisation");
  assert.deepEqual(loaded.problems.sort(), [`expenses: also in /home/box/work/skills, shadowed by the one in ${ROOT}.`, `travel: also in ${ROOT}, shadowed by the one in /home/box/work/skills.`]);
  const index = renderSkills(loaded.skills);
  assert.match(index, /\*\*Expenses\*\* — Use when filing expenses, the organisation's way\. — required by the organisation — read instead of this box's own `\/home\/box\/work\/skills\/expenses\/SKILL\.md`/);
  assert.match(index, /\*\*Travel\*\* — Use when booking travel, this box's way\. — this box's own, read instead of the organisation's skill of the same name/);

  // With no organisation there is no second root, whatever the directory holds, and the index says nothing new.
  const personal = await loadSkills(source, [], "/home/box/work/skills");
  assert.deepEqual(personal.skills.map(skill => skill.path), ["/home/box/work/skills/expenses/SKILL.md", "/home/box/work/skills/travel/SKILL.md"]);
  assert.doesNotMatch(renderSkills(personal.skills), /organisation/);
});

test("the index budget: a required organisation skill keeps its description, and the others are the first to become a bare name", () => {
  const own = (n: number): Skill => ({ slug: `own-${n}`, name: `Own ${n}`, description: `Use when asked for thing ${n}. ${"It does a thing. ".repeat(12)}`.slice(0, 230), scope: "global", path: `/home/box/work/skills/own-${n}/SKILL.md`, helpers: [] });
  const org = (n: number, required = false): Skill => ({ ...own(n), slug: `org-${n}`, name: `Org ${n}`, path: `${ROOT}/org-${n}/SKILL.md`, origin: "organisation", ...(required ? { required: true as const } : {}) });
  // Forty of the box's own leave room for a few more and not for ten.
  const shipped = Array.from({ length: 40 }, (_, n) => own(n));
  const before = renderSkills(shipped);
  assert.doesNotMatch(before, /more not described/);
  const ten = [...Array.from({ length: 9 }, (_, n) => org(n)), org(9, true)];
  const after = renderSkills([...ten, ...shipped]);
  for (const skill of shipped) assert.ok(after.includes(`**${skill.name}** — `), `${skill.slug} kept its description`);
  assert.ok(after.includes("**Org 9** — "), "the required one kept its description, though it is listed last of the ten");
  const trimmed = /- \((\d+) more not described here because the index is full — ([^;]+); each is at `([^`]+)`\)/.exec(after);
  assert.ok(trimmed !== null, "the rest of the organisation's are named, not described");
  assert.equal(trimmed![3], `${ROOT}/<slug>/SKILL.md`, "with the directory they are in");
  assert.ok(trimmed![2]!.split(", ").every(slug => /^org-[0-8]$/.test(slug)));
  // And the other way round: one of the box's own is never what pays for an organisation skill that is not required.
  const described = (index: string) => index.split("\n").filter(line => line.startsWith("- **")).reduce((sum, line) => sum + line.length, 0);
  assert.ok(described(after) <= SKILL_INDEX_CHARS && described(after) > described(before), "the room that was left is used, and the budget holds");
});
