/**
 * The rails of a template: what may travel, what is refused with its line named, how a
 * routine's ids become placeholders, and whether the reconcile tells the truth.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkillFile } from "./skills.ts";
import {
  type BotTemplate,
  TEMPLATE_CUE,
  TEMPLATE_FORMAT,
  generaliseRoutine,
  packSkillText,
  packTemplate,
  parseTemplate,
  pendingOf,
  reconcile,
  renderRecipe,
  resolvePlaceholders,
  rewriteFrontmatter,
  stampTemplateWrite,
  templateSetupCue,
  tierOf,
  toolsOf,
  unresolvedPlaceholders,
} from "./template.ts";

const SKILL = `---
name: 音视频转写
description: >-
  Use this when the user wants a transcript
  of a video.
scope: global
---
Fetch the audio, transcribe it, write the transcript to ~/work/out.
`;

const ROUTINE = `---
name: Weekly digest
description: Every Monday, the week in one message.
schedule: "0 9 * * 1"
timezone: Asia/Shanghai
deliver: feishu:oc_1234567890abcdef
agent: Ada
authored_by: Ada
because: the person asked every Monday
---
Collect what Bob and Ada shipped, post it to feishu:oc_1234567890abcdef, cc @Bob.
`;

function fixture(overrides: Partial<BotTemplate> = {}): BotTemplate {
  return {
    format: TEMPLATE_FORMAT,
    profile: { name: "下载专家", description: "Turns videos into Chinese transcripts.", tools: "web" },
    memory: [{ kind: "fact", text: "Without official subtitles, transcribe with the ASR engine; the key comes from the environment." }],
    skills: [{ slug: "transcribe", name: "音视频转写", description: "Transcribe a video.", files: { "SKILL.md": SKILL, "scripts/dl.sh": "#!/bin/sh\nyt-dlp \"$1\"\n" } }],
    routines: [],
    connectors: ["browser"],
    ...overrides,
  };
}

test("a template round-trips through JSON and the boundary is enforced field by field", () => {
  const parsed = parseTemplate(JSON.stringify(fixture()));
  assert.ok("template" in parsed, JSON.stringify(parsed));
  assert.equal(parsed.template.profile.name, "下载专家");
  assert.deepEqual(toolsOf(parsed.template)?.slice(0, 2), ["bash", "Jobs"]);
  assert.equal(parsed.template.skills[0]?.files["scripts/dl.sh"]?.startsWith("#!/bin/sh"), true);

  const wrongFormat = parseTemplate({ ...fixture(), format: "grok/1" });
  assert.ok("problem" in wrongFormat && /format/.test(wrongFormat.problem));

  const episode = parseTemplate(fixture({ memory: [{ kind: "episode" as never, text: "we did a thing" }] }));
  assert.ok("problem" in episode && /episodes and notes do not travel/.test(episode.problem));

  const owner = parseTemplate(fixture({ skills: [{ slug: "x", name: "x", description: "d", files: { "SKILL.md": "---\nname: x\nowner: Bob\n---\nbody\n" } }] }));
  assert.ok("problem" in owner && /"owner:", which never travels/.test(owner.problem));

  const traversal = parseTemplate(fixture({ skills: [{ slug: "x", name: "x", description: "d", files: { "SKILL.md": SKILL, "../etc/passwd": "x" } }] }));
  assert.ok("problem" in traversal && /unsafe path/.test(traversal.problem));

  const notARoutine = parseTemplate(fixture({ routines: [{ slug: "r", name: "r", description: "d", files: { "SKILL.md": SKILL }, fillIns: [] }] }));
  assert.ok("problem" in notARoutine && /neither schedule: nor trigger:/.test(notARoutine.problem));

  const orphanStart = parseTemplate(fixture({ gettingStarted: { skill: "nope" } }));
  assert.ok("problem" in orphanStart && /gettingStarted/.test(orphanStart.problem));
  const byName = parseTemplate(fixture({ gettingStarted: { skill: "音视频转写" } }));
  assert.ok("template" in byName && byName.template.gettingStarted?.skill === "transcribe");
});

test("a credential anywhere in the document refuses the whole export, with the place named", () => {
  const inMemory = parseTemplate(fixture({ memory: [{ kind: "fact", text: "The key is sk-abcdefghijklmnopqrstuvwxyz0123 and lives in the env." }] }));
  assert.ok("problem" in inMemory && /memory\[0\]/.test(inMemory.problem) && /openai-anthropic/.test(inMemory.problem));
  const inHelper = parseTemplate(fixture({ skills: [{ slug: "x", name: "x", description: "d", files: { "SKILL.md": SKILL, "scripts/env.sh": "token = \"abcdefghijklmnopq\"\n" } }] }));
  assert.ok("problem" in inHelper && /x\/scripts\/env\.sh/.test(inHelper.problem));
});

test("frontmatter surgery keeps what it does not know about and takes a block with its key", () => {
  const rewritten = rewriteFrontmatter(SKILL, { drop: ["scope"], set: { description: "one line" }, add: { paused: "true" } });
  const meta = parseSkillFile(rewritten).meta;
  assert.equal(meta.description, "one line");
  assert.equal(meta.paused, "true");
  assert.equal(meta.scope, undefined);
  assert.equal(meta.name, "音视频转写");
  assert.match(rewritten, /Fetch the audio/);
  assert.doesNotMatch(rewritten, /of a video/, "the folded block went with its key");

  const packed = parseSkillFile(packSkillText(ROUTINE)).meta;
  assert.equal(packed.authored_by, undefined);
  assert.equal(packed.because, undefined);
  assert.equal(packed.agent, undefined);
  assert.equal(packed.deliver, undefined);
  assert.equal(packed.scope, "global");
});

test("a routine's installation-specific ids become placeholders and a fill-in list", () => {
  const { text, fillIns } = generaliseRoutine(ROUTINE, { self: "Ada", teammates: ["Bob", "Ada"] });
  const meta = parseSkillFile(text).meta;
  assert.equal(meta.deliver, "{feishu_chat}");
  assert.equal(meta.agent, "{self}");
  assert.equal(meta.timezone, "{timezone}");
  assert.equal(meta.schedule, "0 9 * * 1");
  assert.equal(meta.authored_by, undefined);
  assert.doesNotMatch(text, /oc_1234567890abcdef/, "the chat key is gone from the body too");
  assert.match(text, /Collect what \{teammate\} and \{self\} shipped/);
  assert.match(text, /post it to \{feishu_chat\}, cc \{teammate\}\./);
  assert.match(text, /Ask the importing user for:\n- Timezone \(`\{timezone\}`\)\n- Feishu chat to deliver to \(`\{feishu_chat\}`\)\n- Teammate to hand work to/);
  assert.deepEqual(fillIns.map(fillIn => fillIn.id), ["timezone", "feishu_chat", "teammate"]);

  // Idempotent: generalising the generalised text neither doubles the list nor invents ids.
  const again = generaliseRoutine(text, { self: "Ada", teammates: ["Bob"] });
  assert.equal((again.text.match(/Ask the importing user for:/g) ?? []).length, 1);

  assert.equal(resolvePlaceholders("post to {feishu_chat} as {self}, tz {timezone}", { feishu_chat: "feishu:oc_new" }, "Ada"), "post to feishu:oc_new as Ada, tz {timezone}");
  assert.deepEqual(unresolvedPlaceholders("post to {feishu_chat} as {self}, tz {timezone}"), ["feishu_chat", "timezone"]);
});

test("what the setup turn writes is stamped: a routine starts paused whether or not the bot remembered", () => {
  const routine = stampTemplateWrite("---\nname: r\ndescription: d\nschedule: \"@daily\"\n---\nbody\n", "abc");
  const meta = parseSkillFile(routine).meta;
  assert.equal(meta.paused, "true");
  assert.equal(meta.authored_by, "template:abc");
  const unpaused = stampTemplateWrite("---\nname: r\ndescription: d\ntrigger: message\nmatch: hello\npaused: false\n---\nbody\n", "abc");
  assert.equal(parseSkillFile(unpaused).meta.paused, "true", "a bot cannot write it on");
  const skill = stampTemplateWrite(SKILL, "abc");
  assert.equal(parseSkillFile(skill).meta.paused, undefined, "a plain skill has nothing to pause");
  assert.equal(parseSkillFile(skill).meta.authored_by, "template:abc");
  assert.equal(stampTemplateWrite("no frontmatter here", "abc"), "no frontmatter here");
});

test("the recipe the new bot reads has its own name in place of {self}, and the cue points at it", () => {
  const routine = generaliseRoutine(ROUTINE, { self: "Ada", teammates: ["Bob"] });
  const template = fixture({
    routines: [{ slug: "weekly-digest", name: "Weekly digest", description: "d", files: { "SKILL.md": routine.text }, fillIns: routine.fillIns }],
    gettingStarted: { skill: "transcribe" },
    meta: { createdBy: "kin" },
  });
  const recipe = renderRecipe(template, { self: "Vera" });
  assert.match(recipe, /^# Recipe for Vera — from the template "下载专家" by kin/);
  assert.match(recipe, /agent: Vera/);
  assert.match(recipe, /deliver: \{feishu_chat\}/, "what the person must supply stays a placeholder");
  assert.match(recipe, /File `\/home\/box\/work\/skills\/transcribe\/scripts\/dl\.sh`/);
  assert.match(recipe, /Read and follow the skill `transcribe`/);

  const pending = pendingOf(template, ["feishu"]);
  assert.deepEqual(pending.connectors, ["browser"]);
  assert.deepEqual(pending.fillIns.map(fillIn => fillIn.id), ["timezone", "feishu_chat", "teammate"]);

  const cue = templateSetupCue({ template, self: "Vera", recipePath: "/home/box/work/templates/vera/recipe.md", createdBy: "chris", pending });
  assert.ok(cue.startsWith(TEMPLATE_CUE));
  assert.match(cue, /created by chris from the template "下载专家" by kin/);
  assert.match(cue, /write each skill to \/home\/box\/work\/skills\/<slug>\/SKILL\.md with write_file/);
  assert.match(cue, /save each memory with RememberFact/);
  assert.match(cue, /`paused: true`/);
  assert.match(cue, /one at a time: Timezone; Feishu chat to deliver to; Teammate to hand work to; browser is not connected here/);
  assert.match(cue, /Read and follow the skill "transcribe" before you speak\.$/);
});

test("reconcile says what landed, what did not, and which routine came in unpaused", () => {
  const routine = generaliseRoutine(ROUTINE, { self: "Ada" });
  const template = fixture({
    memory: [
      { kind: "fact", text: "Transcribe with the ASR engine; the key comes from the environment." },
      { kind: "fact", text: "Papers download without any key." },
    ],
    routines: [
      { slug: "weekly-digest", name: "Weekly digest", description: "d", files: { "SKILL.md": routine.text }, fillIns: routine.fillIns },
      { slug: "nightly", name: "Nightly", description: "d", files: { "SKILL.md": routine.text }, fillIns: [] },
    ],
  });
  const result = reconcile(template, {
    skillDirs: ["transcribe-2", "weekly-digest", "unrelated"],
    skillFiles: new Map([["weekly-digest", "---\nname: w\nschedule: \"@daily\"\n---\nbody"]]),
    memoryTexts: ["Transcribe with the ASR engine; the key comes from the environment", "something else"],
  });
  assert.deepEqual(result.added, { skills: ["transcribe"], routines: ["weekly-digest"], memories: 1 });
  assert.deepEqual(result.missing.routines, ["nightly"]);
  assert.deepEqual(result.missing.memories, ["Papers download without any key."]);
  assert.deepEqual(result.unpaused, ["weekly-digest"]);
  assert.equal(result.summary, "Added 下载专家, but not all of it: missing routines nightly; 1 memory.");

  const whole = reconcile(fixture(), {
    skillDirs: ["transcribe"],
    skillFiles: new Map(),
    memoryTexts: ["Without official subtitles, transcribe with the ASR engine; the key comes from the environment."],
  });
  assert.equal(whole.summary, "Added 下载专家: 1 skill, 1 memory.");
});

test("packing reads the live files: a slug that is not there is dropped and named, a body replaces only the body, a routine is generalised", async () => {
  const disk = new Map<string, string>([
    ["/home/box/work/skills/transcribe/SKILL.md", SKILL],
    ["/home/box/work/skills/transcribe/scripts/dl.sh", "#!/bin/sh\nyt-dlp \"$1\"\n"],
    ["/home/box/work/skills/weekly-digest/SKILL.md", ROUTINE],
    ["/home/box/work/skills/bobs/SKILL.md", "---\nname: bobs\ndescription: d\nscope: agent\nowner: Bob\n---\nbody\n"],
  ]);
  const source = {
    async listDir(path: string) {
      const entries = new Map<string, string>();
      for (const file of disk.keys()) {
        if (!file.startsWith(`${path}/`)) continue;
        const rest = file.slice(path.length + 1);
        const head = rest.split("/")[0]!;
        entries.set(head, rest.includes("/") ? "directory" : "file");
      }
      if (entries.size === 0) throw new Error("no such directory");
      return { entries: [...entries].map(([name, type]) => ({ name, type })) };
    },
    async readFile(path: string) {
      const content = disk.get(path);
      if (content === undefined) throw new Error("no such file");
      return { content };
    },
  };
  const context = {
    self: { name: "Ada", title: "转写", avatarColor: "brown", tools: ["bash", "Jobs", "read_file", "write_file", "edit_file", "list_dir", "SetPlan", "SetTodos", "ReadHistory", "RememberFact", "Recall", "SendToAgent", "AskUser", "OtherThreads", "Tasks", "ClaimWork"] },
    teammates: ["Bob"],
    memoryRecords: [
      { at: "2026-09-01T00:00:00Z", kind: "fact" as const, text: "Chris prefers replies in Chinese and works from Shanghai.", about: "chris" },
      { at: "2026-09-01T00:00:00Z", kind: "fact" as const, text: "Without official subtitles, transcribe with the ASR engine.", source: "RememberFact" },
    ],
    createdBy: "chris",
    now: () => "2026-09-02T00:00:00Z",
  };
  const result = await packTemplate(
    source,
    {
      profile: { description: "Turns videos into Chinese transcripts." },
      memory: [{ text: "Without official subtitles, transcribe with the ASR engine; the key comes from the environment." }],
      skills: [
        { slug: "transcribe", body: "Fetch the audio, transcribe it with the engine the person configured, write the transcript to ~/work/out." },
        { slug: "missing" },
        { slug: "bobs" },
      ],
      routines: [{ slug: "weekly-digest" }],
      connectors: ["feishu", "feishu", ""],
    },
    context
  );
  assert.ok("template" in result, JSON.stringify(result));
  assert.deepEqual(result.dropped, ["missing: no such skill here", "bobs: belongs to Bob, not to you"]);
  const { template } = result;
  assert.equal(template.profile.name, "Ada");
  assert.equal(template.profile.title, "转写");
  assert.equal(template.profile.tools, "desk", "a tier when the set is one");
  assert.deepEqual(template.connectors, ["feishu"]);
  assert.equal(template.meta?.createdBy, "chris");
  const skill = template.skills[0]!;
  assert.match(skill.files["SKILL.md"]!, /transcribe it with the engine the person configured/);
  assert.match(skill.files["SKILL.md"]!, /description: Use this when the user wants a transcript of a video\./, "the frontmatter is the file's, not the bot's");
  assert.equal(skill.files["scripts/dl.sh"]?.startsWith("#!/bin/sh"), true, "helpers ride along");
  const routine = template.routines[0]!;
  assert.deepEqual(routine.fillIns.map(fillIn => fillIn.id), ["timezone", "feishu_chat", "teammate"]);
  assert.equal(parseSkillFile(routine.files["SKILL.md"]!).meta.agent, "{self}");

  // A memory about a person is refused whatever words it arrives in.
  const personal = await packTemplate(source, { profile: { description: "d" }, memory: [{ text: "Chris prefers replies in Chinese and works from Shanghai, so answer in Chinese." }], skills: [], routines: [], connectors: [] }, context);
  assert.ok("refused" in personal && /about a person here/.test(personal.refused));

  // A raw file copy as the body is dropped, not packed twice over.
  const raw = await packTemplate(source, { profile: { description: "d" }, memory: [], skills: [{ slug: "transcribe", body: SKILL }], routines: [], connectors: [] }, context);
  assert.ok("template" in raw && raw.dropped[0]?.includes("raw file copy"));

  assert.equal(tierOf(undefined), undefined);
  assert.deepEqual(tierOf(["bash", "computer"]), ["bash", "computer"]);
});
