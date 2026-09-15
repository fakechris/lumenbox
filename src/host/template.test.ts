/**
 * The rails of a template: what may travel, what is refused with its line named, how a
 * routine's ids become placeholders, and whether the reconcile tells the truth.
 */

import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLearnings } from "./learnings.ts";
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
  resolveBundleRefs,
  describeBundleGaps,
  manifestOf,
  installLearnings,
  reconcile,
  renderRecipe,
  resolvePlaceholders,
  rewriteFrontmatter,
  stampTemplateWrite,
  templateSetupCue,
  tierOf,
  toolsOf,
  unresolvedPlaceholders,
  catalogTemplate,
  templatesEnabled,
  TEMPLATE_SETUP_TOOLS,
} from "./template.ts";
import { CATALOG_EXPERTS } from "./catalog.ts";

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
  // No timezone known to this cue, so it stays a question; the chat is deferred; the one
  // real question is the teammate; the connector is told, not asked.
  assert.match(cue, /Leave \{feishu_chat\} empty/);
  assert.match(cue, /exactly one question, the first of these, the rest only if they ask: Timezone; Teammate to hand work to/);
  assert.match(cue, /Not connected here, and not yours to ask about: browser/);
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
    self: { name: "Ada", title: "转写", avatarColor: "brown", tools: ["bash", "Jobs", "read_file", "write_file", "edit_file", "list_dir", "SetPlan", "SetTodos", "ReadHistory", "RememberFact", "Recall", "SendToAgent", "Teammates", "AskUser", "AskSecret", "HandOverDesktop", "OtherThreads", "Tasks", "ClaimWork"] },
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

test("a catalog expert is a template in the same format, with nothing to install and its tier named", () => {
  const lin = CATALOG_EXPERTS.find(expert => expert.slug === "lin")!;
  const template = catalogTemplate(lin);
  const parsed = parseTemplate(JSON.stringify(template));
  assert.ok("template" in parsed, JSON.stringify(parsed));
  assert.equal(parsed.template.profile.name, "Lin");
  assert.equal(parsed.template.profile.tools, "code");
  assert.deepEqual(parsed.template.skills, []);
  assert.equal(parsed.template.meta?.sourceName, "lin");
  const cue = templateSetupCue({ template, self: "Lin", recipePath: "/x", pending: { fillIns: [], connectors: [] } });
  assert.match(cue, /there is nothing else to install/);
  assert.doesNotMatch(cue, /read it now/);

  assert.equal(templatesEnabled({}), true);
  assert.equal(templatesEnabled({ AGENTBOX_TEMPLATES: "0" }), false);
  assert.ok(!TEMPLATE_SETUP_TOOLS.includes("bash") && !TEMPLATE_SETUP_TOOLS.includes("SendToAgent") && TEMPLATE_SETUP_TOOLS.includes("write_file"));
});


// ── bundle references: names and needs, resolved by the receiver (INV-421) ─────────────
test("a template names the bundles its work used, with needs and never values; the receiver resolves them", () => {
  const withBundles = parseTemplate({
    ...fixture(),
    bundles: [
      { name: "github", needs: { connectors: ["mcp:github"], secretIds: ["GITHUB_TOKEN"], repositories: [{ path: "/repo", mode: "rw" }] } },
      { name: "notes" },
    ],
  });
  assert.ok("template" in withBundles);
  assert.deepEqual(withBundles.template.bundles?.map(b => b.name), ["github", "notes"]);
  const leaking = parseTemplate({ ...fixture(), bundles: [{ name: "github", needs: { token: "ghp_x" } }] });
  assert.ok("problem" in leaking && /never its values/.test(leaking.problem));

  const refs = withBundles.template.bundles!;
  // Nothing attached: both missing, with what the work used them for.
  const none = resolveBundleRefs(refs, undefined);
  assert.deepEqual(none.map(r => r.status), ["missing", "missing"]);
  assert.match(describeBundleGaps(none)[0]!, /bundle "github" is not attached to this box \(the work used it for: connector mcp:github, secret GITHUB_TOKEN, \/repo rw\)/);
  // Same name, a read-only grant: a conflict naming what it lacks — never upgraded to match the template.
  const readonly = resolveBundleRefs(refs, { names: ["github", "notes"], connectors: ["mcp:github"], secretIds: ["GITHUB_TOKEN"], skills: undefined, mcpServers: [], repositories: [{ path: "/repo", mode: "ro" }] });
  assert.deepEqual(readonly, [{ name: "github", status: "conflict", lacks: ["/repo rw"] }, { name: "notes", status: "resolved" }]);
  // The same bundle covering the needs: resolved.
  const full = resolveBundleRefs(refs, { names: ["github", "notes"], connectors: ["mcp:github"], secretIds: ["GITHUB_TOKEN"], skills: undefined, mcpServers: [], repositories: [{ path: "/repo", mode: "rw" }] });
  assert.deepEqual(full.map(r => r.status), ["resolved", "resolved"]);

  // Pending carries the gaps, and the cue tells the bot to say so and stop — not to ask for keys.
  const pending = pendingOf(withBundles.template, ["feishu", "browser"], readonly);
  assert.deepEqual(pending.bundles.map(r => r.name), ["github"]);
  const cue = templateSetupCue({ template: withBundles.template, self: "Vera", recipePath: "/home/box/work/templates/vera/recipe.md", pending });
  assert.match(cue, /bundle "github" is attached but does not provide \/repo rw/);
  assert.match(cue, /a person attaches bundles in Settings → Boxes; do not ask for keys/);
  assert.match(cue, /do not treat a same-named bundle as the same grant/);
  const clean = templateSetupCue({ template: withBundles.template, self: "Vera", recipePath: "/x", pending: pendingOf(withBundles.template, ["feishu", "browser"], full) });
  assert.doesNotMatch(clean, /Capabilities this recipe was made with/);
});

test("packing carries the author's bundles as names and needs, and nothing when the box has none", async () => {
  const source = { listDir: async () => ({ entries: [] }), readFile: async () => ({ content: "" }) };
  const selection = { profile: { description: "A bot." }, memory: [], skills: [], routines: [], connectors: [] };
  const base = { self: { name: "Ada" }, teammates: [], memoryRecords: [] };
  const packed = await packTemplate(source, selection, { ...base, bundles: [{ name: "github", needs: { secretIds: ["GITHUB_TOKEN"] } }] });
  assert.ok("template" in packed);
  assert.deepEqual(packed.template.bundles, [{ name: "github", needs: { secretIds: ["GITHUB_TOKEN"] } }]);
  assert.doesNotMatch(JSON.stringify(packed.template), /ghp_|value/);
  const bare = await packTemplate(source, selection, base);
  assert.ok("template" in bare && bare.template.bundles === undefined);
});

// ── learnings travel; the manifest is read, not trusted (INV-411) ───────────────────────
test("site learnings travel by host as dated lines, are scanned for secrets, and install once into the receiver's own store", () => {
  const withNotes = parseTemplate({
    ...fixture(),
    learnings: [
      { host: "https://www.shop.test/cart", lines: ["- 2026-09-01 ✅ the coupon field is under Order summary (by Ada)", "- 2026-09-02 ❌ the Apply button ignores Enter; click it", "not a note"] },
      { host: "nowhere at all", lines: ["- 2026-09-01 ✅ x"] },
    ],
  });
  assert.ok("problem" in withNotes && /not a host name/.test(withNotes.problem));
  const good = parseTemplate({ ...fixture(), learnings: [{ host: "https://www.shop.test/cart", lines: ["- 2026-09-01 ✅ the coupon field is under Order summary (by Ada)", "- 2026-09-02 ❌ the Apply button ignores Enter; click it", "not a note"] }] });
  assert.ok("template" in good);
  assert.deepEqual(good.template.learnings, [{ host: "shop.test", lines: ["- 2026-09-01 ✅ the coupon field is under Order summary (by Ada)", "- 2026-09-02 ❌ the Apply button ignores Enter; click it"] }]);

  const leaking = parseTemplate({ ...fixture(), learnings: [{ host: "shop.test", lines: ["- 2026-09-01 ✅ log in with token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab"] }] });
  assert.ok("problem" in leaking && /learnings\.shop\.test\[0\] looks like it holds a credential/.test(leaking.problem), "a canary in a note refuses the whole document, with the place named");

  const traversal = parseTemplate({ ...fixture(), skills: [{ slug: "x", name: "x", description: "d", files: { "SKILL.md": "---\nname: x\n---\n", "../../etc/passwd": "x" } }] });
  assert.ok("problem" in traversal && /unsafe path/.test(traversal.problem));

  const dir = mkdtempSync(join(tmpdir(), "agentbox-tpl-learn-"));
  try {
    const first = installLearnings(good.template, "tpl_1", dir);
    assert.deepEqual(first, { installed: 2, skipped: 0 });
    const again = installLearnings(good.template, "tpl_1", dir);
    assert.deepEqual(again, { installed: 0, skipped: 2 }, "a re-import is one set of notes");
    const lines = readLearnings("shop.test", dir);
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^- 2026-09-01 ✅ the coupon field is under Order summary/);
    assert.match(lines[0]!, /template:tpl_1/, "every installed line says where it came from");
    assert.match(lines[1]!, /❌ the Apply button ignores Enter/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const manifest = manifestOf({ ...good.template, bundles: [{ name: "github", needs: { secretIds: ["GITHUB_TOKEN"] } }], meta: { createdBy: "kin", version: 3 } }, ["private-notes: belongs to Bob, not to you"]);
  assert.equal(manifest[0], 'Template "下载专家" v3 by kin');
  assert.ok(manifest.some(l => /skill transcribe —/.test(l)));
  assert.ok(manifest.some(l => /learnings for shop.test: 2 note\(s\), 2026-09-01 → 2026-09-02, by Ada/.test(l)));
  assert.ok(manifest.some(l => /needs bundle "github" \(secret GITHUB_TOKEN\)/.test(l)));
  assert.ok(manifest.some(l => /excluded by rule: cookies, tokens and secret values, transcripts, recordings, memory about people/.test(l)));
  assert.ok(manifest.some(l => /left out: private-notes: belongs to Bob/.test(l)));
});

test("packing takes learnings from the author's store by host, and says when there are none", async () => {
  const source = { listDir: async () => ({ entries: [] }), readFile: async () => ({ content: "" }) };
  const packed = await packTemplate(
    source,
    { profile: { description: "A bot." }, memory: [], skills: [], routines: [], connectors: [], learnings: ["https://shop.test/x", "empty.test", "not a host"] },
    { self: { name: "Ada" }, teammates: [], memoryRecords: [], learningsFor: host => (host === "shop.test" ? ["- 2026-09-01 ✅ a note (by Ada)"] : []) }
  );
  assert.ok("template" in packed);
  assert.deepEqual(packed.template.learnings, [{ host: "shop.test", lines: ["- 2026-09-01 ✅ a note (by Ada)"] }]);
  assert.deepEqual(packed.dropped, ["learnings for empty.test: nothing kept here", 'learnings for "not a host": not a host name']);
});
