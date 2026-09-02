/**
 * The skills a fresh box starts with.
 *
 * A skill system with zero skills teaches nobody what a skill is — the same blank-page
 * problem the starter team solves for agents. The first four show the shapes a
 * skill takes (browser, corpus, filesystem, scheduled). The rest are domain
 * procedures — code review, Chinese longform / notes / scripts, data briefs —
 * written the same way: files under /home/box/work, no invented sources. Alongside
 * them, skill-hub packages in catalog-data/skills/ are copied as-is (humanizer,
 * khazix-writer, diagnose, fullstack-dev, …) so experts compose standard skills
 * rather than paraphrased stubs. Anything tied to one vendor's account still
 * belongs to the person who has that account.
 *
 * Seeded per skill, once, with a marker recording what has been offered. The first
 * version seeded only into an *empty* directory, and that guard aged into a bug:
 * `study-a-corpus` was added after the guard landed and could never reach a box that
 * already had the original three — written, tested, committed, and absent at runtime
 * (docs/14). The rule both versions are protecting still holds: **a person who deleted a
 * starter skill deleted it**, and reseeding it every restart would be the
 * config-file-overwrite bug wearing a different coat. Hence the marker: a skill is
 * seeded only if it has never been offered — neither present on disk nor recorded in
 * `.seeded` — so a deletion stays deleted and a new starter still arrives.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { SKILLS_DIR } from "./skills.ts";
import { catalogDataDir, hubSkillSlugs } from "./catalog.ts";

/** Records which starters have ever been offered, so deletion and novelty stay distinct. */
export const SEEDED_MARKER = ".seeded";

/**
 * Which starters to seed: those neither on disk nor ever offered before.
 *
 * Pure, because the mistake this replaces was in exactly this decision and survived
 * because nothing could test it without a box.
 */
export function unseededStarters(
  markerText: string | undefined,
  existing: readonly string[],
  starters: readonly { slug: string }[] = STARTERS
): string[] {
  const offered = new Set(existing);
  for (const line of (markerText ?? "").split("\n")) {
    const slug = line.trim();
    if (slug !== "") offered.add(slug);
  }
  return starters.map(starter => starter.slug).filter(slug => !offered.has(slug));
}

interface StarterSkill {
  slug: string;
  content: string;
}

const STARTERS: readonly StarterSkill[] = [
  {
    slug: "research-brief",
    content: `---
name: research-brief
description: Research a topic in the browser and write a sourced brief to the work directory.
scope: global
---

# Research brief

Given a topic, produce a short brief a person can trust, with sources.

1. Open the browser and search the topic. Use two or three differently-phrased
   queries — one phrasing finds one literature.
2. Open the three most substantial results. Prefer primary sources over summaries
   of summaries. Note the URL of everything you actually read.
3. Write \`/home/box/work/briefs/<topic-slug>.md\`:
   - Three to six findings, one paragraph each, each ending with its source URL.
   - A "What I could not verify" section for anything that appeared once and nowhere else.
4. Reply with the file path and the two most important findings in two sentences.

Do not pad. A brief that says "the sources disagree" is a finding.
`,
  },
  {
    slug: "study-a-corpus",
    content: `---
name: study-a-corpus
description: Read a large body of documents once, and leave notes that make every later question cheap.
scope: global
---

# Study a corpus

For material too large to read per question — a dataroom, an archive, a repository of
reports. Reading it fresh every time costs the same again and again; reading it once and
writing down its shape costs once. Do this before the questions start, not during.

1. **Survey without reading.** \`ls\`, \`find\`, \`wc -l\` — how many files, how big, what
   kinds, how they are grouped. Do not open them yet.
2. **Find the shape.** Open five or six files spread across the corpus and ask what
   fields every one of them has: a date, a party, a status, a category. That set is the
   schema, and it comes from the material rather than from a guess.
3. **Fork over the slices.** Split the corpus into pieces that do not overlap and give
   each fork one piece plus the same instruction: for every document, report those
   fields and one line on what it is. Keep the pieces large enough that a fork reads
   many documents.
4. **Write the notes.** Combine the findings into
   \`/home/box/work/notes/<corpus>/index.md\`: one line per document, the schema fields
   first. Add \`by-<field>.md\` for the groupings worth having (by date, by category).
   Aim for the notes to be about a hundredth of what you read.
5. **Say what the notes cover and what they flatten.** A note that hides its own
   coverage will be trusted past where it is true.

Afterwards, answer questions by reading the notes first and opening only the documents
they point at. When an answer is not in the notes, that is a gap worth adding — the
notes are a living index, not a one-time export.
`,
  },
  {
    slug: "tidy-downloads",
    content: `---
name: tidy-downloads
description: Sort the Downloads directory into the work directory by type and month.
scope: global
---

# Tidy downloads

Move everything in \`~/Downloads\` into \`/home/box/work/files/<year>-<month>/<kind>/\`,
where kind is one of: documents, images, video, audio, archives, code, other.

1. List what is there first. If it is empty, say so and stop — do not invent work.
2. Move with \`mv\`, never copy-then-delete: a crash mid-copy leaves two half files.
3. Leave anything currently being written to (size changing between two checks) alone.
4. Reply with a count per kind and anything you left in place, and why.
`,
  },
  {
    slug: "morning-summary",
    content: `---
name: morning-summary
description: Summarise yesterday's work directory changes into one morning note.
scope: global
---

# Morning summary

Write \`/home/box/work/notes/morning-<date>.md\` covering the last 24 hours:

1. \`find /home/box/work -newermt "24 hours ago" -type f\` — what changed.
2. For each changed report or brief, one line on what it now says.
3. One "needs a decision" list: anything a teammate flagged, any consent that was
   refused, any task that stalled.
4. Reply with the note's path and the needs-a-decision list, nothing else.

To run this every morning without being asked, add a schedule line to the
frontmatter above, for example: \`schedule: daily 08:30\`. Scheduled runs are
announced when they finish, and a missed window is skipped, never replayed.
`,
  },
  {
    slug: "weekly-retro",
    content: `---
name: weekly-retro
description: Write a one-page retro of the last seven days in the work directory.
scope: global
---

# Weekly retro

Write \`/home/box/work/notes/retro-<date>.md\` covering the last seven days.

1. \`find /home/box/work -newermt "7 days ago" -type f\` — what changed.
2. Three lists: shipped (files that exist and were the point), still open (named, not guessed),
   decided (a choice that will otherwise be re-litigated).
3. One "would do differently" paragraph. If nothing would change, say so.
4. Reply with the path and the still-open list.

Do not pad with "great collaboration". Empty weeks get a short file, not a speech.
`,
  },
  {
    slug: "code-review",
    content: `---
name: code-review
description: Review a change for correctness, security and tests; write the review to a file, do not rewrite the code.
scope: global
---

# Code review

Given a path, a diff, or a repository, write \`/home/box/work/reviews/<slug>.md\`.

1. Read the change. If you cannot tell what it was supposed to do, say so and stop.
2. Three sections, in this order:
   - **Blockers** — will lose data, skip auth, break the contract, or ship untested on the path that matters.
   - **Should fix** — missing validation, unclear control flow, a test that asserts the mock.
   - **Nits** — naming, comments. Skip anything a formatter already owns.
3. Every item names a file and a place. "Looks fine" is allowed if you actually ran or read it.
4. Do not restyle. Do not rewrite the change in the review — that is a different job.

Reply with the path and the blocker count.
`,
  },
  {
    slug: "wechat-longform",
    content: `---
name: wechat-longform
description: Draft a WeChat-style long article to the work directory, sourced and readable aloud.
scope: global
---

# WeChat longform

Write \`/home/box/work/articles/<slug>.md\` as a piece someone will finish on their phone.

1. Before drafting: who is the reader, and what should they believe at the end that they did not at the start. If that is missing, ask. One topic.
2. Outline on the page first: hook, two to four sections, one close. Then write.
3. Every non-obvious claim ends with a source URL you opened, or sits under **未核实**. Do not invent quotes or figures.
4. Cut cadence that only a model writes: stacked slogans, "not X but Y" pairs, a three-part list that could have been one sentence.
5. Read it aloud once. A sentence you would not say, rewrite.

This is not a Xiaohongshu note and not a spoken script. Those are other skills.
`,
  },
  {
    slug: "xiaohongshu-note",
    content: `---
name: xiaohongshu-note
description: Draft Xiaohongshu notes — title, cover line, body, variants — without fake first-hand claims.
scope: global
---

# Xiaohongshu note

Write \`/home/box/work/notes/xhs-<slug>.md\`.

1. One note, one promise. Title under 20 Chinese characters. A cover line that can be read on a thumbnail.
2. Body: what it is, who it is for, one concrete detail you can actually stand behind. End with one question or one next step, not a pile of hashtags pretending to be content.
3. Offer 3–5 title/cover variants under the draft, labelled as variants.
4. If nobody here has used the thing, do not write 亲测 / 用了三周 / 亲身. Write it as a reading of public sources, or say you have not used it.

Not a long article. Not a spoken script.
`,
  },
  {
    slug: "short-video-script",
    content: `---
name: short-video-script
description: Write a spoken short-video script with a timed hook, one point, and one ask.
scope: global
---

# Short-video script

Write \`/home/box/work/scripts/<slug>.md\`.

1. Platform and length first (抖音 / 视频号 / other, seconds). Different platforms forgive different openings.
2. Structure on the page:
   - **0–3s hook** — a sentence that makes a thumb stop. Not a greeting.
   - **Middle** — one point, spoken, with a beat the picture can match (you describe the beat; you do not shoot it).
   - **Ask** — one action. Follow, save, or open a link. Not all three.
3. Write it as spoken lines, not as an essay. Mark pauses.
4. You are not promising views, and you are not delivering footage.

Not a WeChat article. Not a Xiaohongshu note.
`,
  },
  {
    slug: "data-brief",
    content: `---
name: data-brief
description: Turn a table into a sourced brief with a quality check first and actions at the end.
scope: global
---

# Data brief

Given a csv, xlsx, or a folder of tables, write \`/home/box/work/briefs/<slug>.md\`.

1. **Quality first.** Row count, empty-rate on key columns, duplicates, date range. If the file cannot answer the question, say so before computing.
2. Then the numbers that answer the question. Every figure names a column, a filter, or a cell. An estimate is labelled 估算 and carries the basis.
3. Close with **所以呢**: two or three actions, or an explicit "not enough to act".
4. Do not invent a row that was not in the file. Do not give investment advice.

Python in the box is allowed for the arithmetic. The brief is the product, not a notebook.
`,
  },
  {
    // The conversation that packs a template (docs/29 §4). Served from the host like Grok
    // Bot serves its export skill from the server, so the wording can change without a
    // client release; the tool it ends in is PackTemplate.
    slug: "export-template",
    content: `---
name: export-template
description: Create a shareable template of yourself. Use when the person wants to share, export, or make a template of this bot; ends in one PackTemplate call.
---
A template is a shareable copy of you: the profile, the memories that are conventions,
the skills, the routines, and the names of the connectors the work needs. You choose what
goes in, rewrite what has to be generalised, and call PackTemplate once. The person then
publishes or downloads it from the card; nothing is shared until they do.

## 1. Read, and say so as you go

Read in this order, and after each one send one short conversational line with counts and
names — "Just read through my routines: weekly-digest and pr-babysitter." Never paste file
contents or a draft.

- **Memories.** Recall, or ~/work/memory/<your name>/profile.md. Facts and pitfalls only;
  episodes and notes are one installation's history and never travel. Do not read another
  agent's memory.
- **Skills.** List ~/work/skills and read the job text of each of yours. Note the folder
  slug. A skill with scope: agent and someone else's owner is theirs, not yours.
- **Routines.** The skills with a schedule: or trigger:. Note the folder slug.
- **Connectors.** What this conversation and the kept routines actually used: feishu,
  dingtalk, telegram, browser, mcp:<server>. Names only.

## 2. Choose

Two separate decisions. What to include is workflow versus this person's private life:
leave out anything that is only theirs. Judge each memory, skill and routine on its own —
a convention sitting next to a secret is still a convention.

Whatever the audience, leave out secrets, credentials, people's names, private links and
trade secrets. When a sensitive bit is one part of a useful item, take the bit out and keep
the rest: "send Meg the Monday staffing plan" becomes "send your staffing lead the Monday
staffing plan". Omit an item only when the sensitive part is the whole of it. Phrases like
"the watched repo" or "the team channel" are already general — keep those.

Chat keys, agent names and the timezone inside a routine become {placeholders} on their
own; you do not have to strip them. Do say who has to fill what in, in your own words,
when you present the card.

Do not say "scrub" to the person. Do not edit a live skill or memory to generalise it —
pass the rewritten text to PackTemplate instead.

## 3. Call

Send one line of what you are keeping versus leaving out — "Keeping 3 memories, 2 skills
and the weekly digest; leaving out the personal notes." — then call PackTemplate once
with: a short storefront description (a sentence or three: what it does, who it is for),
the memories in their original words minus what you took out, the skills and routines by
slug with a body only where you rewrote it, the connector names, and the getting-started
skill if one of them is the one a new copy should read first.

If PackTemplate refuses — a credential, a memory about a person — take that item out and
call again. If it left something out, tell the person in a sentence. The person cannot edit
the card; if they want a change they tell you, and you call again.

If anything was a gray area — might be a trade secret, too specific to this company, a
connector you are not sure the routine needs — say so in one short note after the card,
without quoting the sensitive part. If nothing was, add nothing.
`,
  },
];

/** Uploads whichever starter skills this box has never been offered. */
export async function seedStarterSkills(
  box: {
    listDir: (path: string) => Promise<{ entries: { name: string }[] }>;
    uploadFile: (path: string, base64: string) => Promise<unknown>;
    exec: (
      command: string,
      options?: { timeoutMs?: number; actor?: string }
    ) => Promise<unknown>;
  },
  log: (line: string) => void
): Promise<void> {
  try {
    const listing = await box.listDir(SKILLS_DIR).catch(() => undefined);
    const existing = listing?.entries.map(entry => entry.name) ?? [];
    // `|| true` because an absent marker is the ordinary first-run case, not an error.
    const raw = (await box
      .exec(`cat ${SKILLS_DIR}/${SEEDED_MARKER} 2>/dev/null || true`, {
        timeoutMs: 15_000,
        actor: "host:starter-skills",
      })
      .catch(() => undefined)) as { stdout?: unknown } | undefined;
    const markerText = typeof raw?.stdout === "string" ? raw.stdout : undefined;

    const hub = hubSkillSlugs();
    const missing = unseededStarters(markerText, existing, [
      ...STARTERS,
      ...hub.map(slug => ({ slug })),
    ]);
    if (missing.length === 0) return;

    // Upload refuses a parent that does not exist — the same refusal that stops a
    // stray upload inventing directory trees — so the directories are made first,
    // deliberately, through the shell.
    const dirs = missing.map(slug => `${SKILLS_DIR}/${slug}`).join(" ");
    await box.exec(`mkdir -p ${dirs}`, { timeoutMs: 15_000, actor: "host:starter-skills" });
    for (const skill of STARTERS) {
      if (!missing.includes(skill.slug)) continue;
      await box.uploadFile(
        `${SKILLS_DIR}/${skill.slug}/SKILL.md`,
        Buffer.from(skill.content, "utf8").toString("base64")
      );
    }
    for (const slug of hub) {
      if (!missing.includes(slug)) continue;
      await seedHubSkill(box, slug);
    }

    // The marker records everything offered as of now: what the marker already said,
    // what was on disk (a pre-marker install has skills the marker never heard of, and
    // deleting one of those should also stick), and what was just seeded.
    const starterSlugs = new Set([...STARTERS.map(skill => skill.slug), ...hub]);
    const offered = new Set<string>(missing);
    for (const line of (markerText ?? "").split("\n")) {
      if (line.trim() !== "") offered.add(line.trim());
    }
    for (const name of existing) {
      if (starterSlugs.has(name)) offered.add(name);
    }
    await box.uploadFile(
      `${SKILLS_DIR}/${SEEDED_MARKER}`,
      Buffer.from(`${[...offered].sort().join("\n")}\n`, "utf8").toString("base64")
    );

    log(`seeded ${missing.length} starter skill(s) into ${SKILLS_DIR}: ${missing.join(", ")}`);
  } catch (error) {
    // A box without starter skills still works; the person just starts from blank.
    const detail = error instanceof Error ? error.message : String(error);
    log(`could not seed starter skills: ${detail}`);
  }
}

/** Copies a vendored skill-hub package into the box, helpers included. */
async function seedHubSkill(
  box: {
    uploadFile: (path: string, base64: string) => Promise<unknown>;
    exec: (
      command: string,
      options?: { timeoutMs?: number; actor?: string }
    ) => Promise<unknown>;
  },
  slug: string
): Promise<void> {
  const root = join(catalogDataDir(), "skills", slug);
  const files = listFiles(root);
  const dirs = new Set(files.map(file => dirname(`${SKILLS_DIR}/${slug}/${file.rel}`)));
  await box.exec(`mkdir -p ${[...dirs].join(" ")}`, {
    timeoutMs: 15_000,
    actor: "host:starter-skills",
  });
  for (const file of files) {
    await box.uploadFile(
      `${SKILLS_DIR}/${slug}/${file.rel}`,
      readFileSync(file.abs).toString("base64")
    );
  }
}

function listFiles(root: string): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push({ rel: relative(root, abs).split("\\").join("/"), abs });
    }
  };
  walk(root);
  return out;
}
