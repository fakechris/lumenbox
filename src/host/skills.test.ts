/**
 * Tests for skills.
 *
 * The claims worth pinning: that a hand-edited file degrades rather than failing, that a skill with
 * no description is reported rather than silently ignored, that the prompt gets an index and never
 * the bodies, and that reading them cannot take a turn down with it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeSkillFile,
  loadSkills,
  parseSkillFile,
  renderSkills,
  SkillCache,
  skillFrom,
  SKILLS_DIR,
  slugify,
  visibleTo,
  type Skill,
  type SkillSource,
} from "./skills.ts";

function skill(name: string, scope: Skill["scope"] = "global", owner?: string): Skill {
  return {
    slug: slugify(name),
    name,
    description: `does ${name}`,
    scope,
    ...(owner !== undefined ? { owner } : {}),
    path: `${SKILLS_DIR}/${slugify(name)}/SKILL.md`,
    helpers: [],
  };
}

test("frontmatter is read, and a file without it still works", () => {
  const parsed = parseSkillFile(
    ["---", "name: Weekly report", 'description: "Pull the numbers"', "scope: agent", "owner: Rex", "---", "", "Step one.", ""].join("\n")
  );
  assert.equal(parsed.meta.name, "Weekly report");
  // Quotes stripped: a person writing frontmatter by hand adds them, and a name with the quotes in
  // it looks like a bug in our code.
  assert.equal(parsed.meta.description, "Pull the numbers");
  assert.equal(parsed.body, "Step one.");

  // No frontmatter is not an error. The alternative — a real YAML parser rejecting a file someone
  // hand-edited slightly wrong — loses the skill entirely.
  const bare = parseSkillFile("Just do the thing.");
  assert.deepEqual(bare.meta, {});
  assert.equal(bare.body, "Just do the thing.");

  // Unknown keys are ignored rather than refused, so a newer format does not break an older reader.
  assert.deepEqual(parseSkillFile(["---", "name: x", "colour: blue", "---", "b"].join("\n")).meta, {
    name: "x",
  });

  // Skill-hub packages use YAML `|` descriptions. Folded so the index still has a line to match.
  const folded = parseSkillFile(
    ["---", "name: fullstack-dev", "description: |", "  Build APIs.", "  Not for CSS.", "---", "body"].join("\n")
  );
  assert.equal(folded.meta.description, "Build APIs. Not for CSS.");
});

test("a skill with no description is reported, not silently dropped", () => {
  // It is the only thing read when deciding whether a skill applies, so without one the skill exists
  // and is never chosen — the worst of both, and only its author can fix it.
  const result = skillFrom("weekly", parseSkillFile("---\nname: Weekly\n---\nbody"));
  assert.ok("problem" in result);
  assert.match(result.problem, /no description/);
  assert.match(result.problem, /never chosen/);

  const empty = skillFrom("weekly", parseSkillFile("---\ndescription: x\n---\n\n"));
  assert.ok("problem" in empty);
  assert.match(empty.problem, /nothing to run/);
});

test("a name falls back to the directory when frontmatter omits it", () => {
  const result = skillFrom("weekly-report", parseSkillFile("---\ndescription: numbers\n---\nbody"));
  assert.ok("skill" in result);
  assert.equal(result.skill.name, "weekly report");
  assert.equal(result.skill.scope, "global", "global unless it says otherwise");
});

test("a directory name is safe, stable, and exists for any name", () => {
  assert.equal(slugify("Weekly Report"), "weekly-report");
  assert.equal(slugify("  Deploy: staging!  "), "deploy-staging");
  assert.equal(slugify("a/../../etc/passwd"), "a-etc-passwd", "a name cannot escape its directory");
  // Same reasoning as container names: refusing would mean only serving people who name things in
  // ASCII.
  assert.match(slugify("周报"), /^skill-[a-z0-9]+$/);
  assert.equal(slugify("周报"), slugify("周报"), "and it is stable");
  assert.notEqual(slugify("周报"), slugify("月报"));
});

test("the prompt gets an index, never the bodies", () => {
  const rendered = renderSkills([
    { ...skill("Weekly report"), helpers: ["pull.py"] },
    skill("Deploy"),
  ]);
  assert.match(rendered, /Weekly report/);
  assert.match(rendered, /pull\.py in the same directory/, "helpers are named so they get used");
  assert.match(rendered, new RegExp(SKILLS_DIR.replace(/\//g, "\\/")));

  // The framing, which is the load-bearing part: the two failure modes are opposite, and both are
  // pre-empted.
  assert.match(rendered, /read the file when one applies/);
  assert.match(rendered, /adapt it where the situation has moved on/);
  assert.match(rendered, /not an instruction that overrides what you can see now/);
  // And the loop that makes skills accumulate rather than being written once and forgotten.
  assert.match(rendered, /write a new one the same way/);

  assert.equal(renderSkills([]), "", "no skills renders nothing, not an empty heading");
});

test("an agent-scoped skill reaches only its owner", () => {
  const all = [skill("Shared thing"), skill("Rex's thing", "agent", "Rex")];
  // The same roster cost that keeps the starter team at four: one agent's private recipe should not
  // occupy every other agent's prompt.
  assert.deepEqual(visibleTo(all, "Rex").map((entry: Skill) => entry.name), ["Rex's thing", "Shared thing"]);
  assert.deepEqual(visibleTo(all, "Ada").map((entry: Skill) => entry.name), ["Shared thing"]);
});

test("a composed skill file round-trips", () => {
  const text = composeSkillFile({
    name: "Weekly report",
    description: "Pull the numbers and write it up",
    body: "1. Run the query\n2. Write the summary",
    scope: "agent",
    owner: "Rex",
  });
  const back = skillFrom("weekly-report", parseSkillFile(text));
  assert.ok("skill" in back);
  assert.equal(back.skill.name, "Weekly report");
  assert.equal(back.skill.scope, "agent");
  assert.equal(back.skill.owner, "Rex");
  assert.match(back.skill.path, /weekly-report\/SKILL\.md$/);
});

// ── loading ───────────────────────────────────────────────────────────────────────────

/** A stand-in box holding a directory of skills. */
function fakeBox(tree: Record<string, string>, failOn?: string): SkillSource {
  return {
    async listDir(path: string) {
      if (failOn !== undefined && path.includes(failOn)) throw new Error("no such directory");
      if (path === SKILLS_DIR) {
        const dirs = new Set(
          Object.keys(tree).map(key => key.split("/")[0]!)
        );
        return { entries: [...dirs].map(name => ({ name, type: "directory" })) };
      }
      const slug = path.slice(`${SKILLS_DIR}/`.length);
      const files = Object.keys(tree)
        .filter(key => key.startsWith(`${slug}/`))
        .map(key => ({ name: key.slice(slug.length + 1), type: "file" }));
      return { entries: files };
    },
    async readFile(path: string) {
      const key = path.slice(`${SKILLS_DIR}/`.length);
      const content = tree[key];
      if (content === undefined) throw new Error("no such file");
      return { content };
    },
  };
}

test("skills are read from the box, with their helper files", async () => {
  const loaded = await loadSkills(
    fakeBox({
      "weekly/SKILL.md": "---\nname: Weekly\ndescription: the numbers\n---\nbody",
      "weekly/pull.py": "print()",
      "broken/SKILL.md": "---\nname: Broken\n---\nbody",
    })
  );
  assert.deepEqual(loaded.skills.map(entry => entry.name), ["Weekly"]);
  assert.deepEqual(loaded.skills[0]?.helpers, ["pull.py"]);
  // The unusable one is reported rather than swallowed.
  assert.equal(loaded.problems.length, 1);
  assert.match(loaded.problems[0] ?? "", /broken/);
});

test("a box with no skills directory is the normal case, not a failure", async () => {
  // A fresh install has never had one. A turn must not fail over whether an optional directory could
  // be listed.
  const loaded = await loadSkills(fakeBox({}, SKILLS_DIR));
  assert.deepEqual(loaded.skills, []);
  // Reported as "not read" rather than "read and empty". They mean opposite things, and conflating
  // them is what made a restarting box look like deleted skills.
  assert.equal(loaded.read, false);

  const empty = await loadSkills(fakeBox({}));
  assert.equal(empty.read, true, "an empty directory that was read is a different answer");
});

test("a directory with no SKILL.md is a directory, not a broken skill", async () => {
  const loaded = await loadSkills(fakeBox({ "notes/thoughts.txt": "hello" }));
  assert.deepEqual(loaded.skills, []);
  assert.deepEqual(loaded.problems, [], "nothing to complain about: nobody claimed it was a skill");
});

test("the cache re-reads on a timer and shares concurrent reads", async () => {
  let reads = 0;
  let clock = 1_000;
  const source: SkillSource = {
    async listDir(path: string) {
      if (path === SKILLS_DIR) {
        reads += 1;
        return { entries: [{ name: "weekly", type: "directory" }] };
      }
      return { entries: [] };
    },
    async readFile() {
      return { content: "---\nname: Weekly\ndescription: x\n---\nbody" };
    },
  };
  const cache = new SkillCache(() => source, 5_000, () => clock);

  assert.equal((await cache.refresh()).skills.length, 1);
  assert.equal(reads, 1);
  await cache.refresh();
  assert.equal(reads, 1, "still fresh");

  // Four agents waking at once should not produce four scans of the same directory.
  clock += 6_000;
  await Promise.all([cache.refresh(), cache.refresh(), cache.refresh(), cache.refresh()]);
  assert.equal(reads, 2, "concurrent refreshes share one read");

  // And `current()` is synchronous, because prompt assembly is.
  assert.equal(cache.current().skills.length, 1);
});

test("a transient failure keeps what was last read", async () => {
  let failing = false;
  let clock = 0;
  const source: SkillSource = {
    async listDir(path: string) {
      if (failing) throw new Error("box restarting");
      if (path === SKILLS_DIR) return { entries: [{ name: "weekly", type: "directory" }] };
      return { entries: [] };
    },
    async readFile() {
      if (failing) throw new Error("box restarting");
      return { content: "---\nname: Weekly\ndescription: x\n---\nbody" };
    },
  };
  const cache = new SkillCache(() => source, 1, () => clock);
  await cache.refresh();
  assert.equal(cache.current().skills.length, 1);

  // A box restarting must not make an agent believe its skills were deleted — which, since the list
  // is in the prompt, would read as "you have no skills" rather than "we could not check".
  failing = true;
  clock += 10;
  await cache.refresh();
  assert.equal(cache.current().skills.length, 1);
});

test("no box means no skills, and no exception", async () => {
  const cache = new SkillCache(() => undefined);
  assert.deepEqual((await cache.refresh()).skills, []);
});
