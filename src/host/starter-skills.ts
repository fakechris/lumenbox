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
 *
 * That marker aged into a bug of its own, the same shape one turn later. It recorded
 * *that* a skill had been offered and not *which version*, so "already there" and "already
 * correct" became the same answer. On 2026-09-24 `daily-research-digest` shipped pointing
 * at a host path its reader cannot see; the fix reached new boxes and could never reach
 * the box that already had the broken copy, and nothing said so (INV-688).
 *
 * So the marker records a digest per slug, and there are three answers instead of two:
 * never offered, seed it; offered and untouched since, update it; offered and **changed by
 * a person**, leave it and say so. The last one is the rule this file has always been
 * protecting, now stated as a comparison rather than inferred from presence. A digest that
 * matches what we last wrote means nobody has touched it; anything else is theirs.
 *
 * Skill-hub packages are not covered by the update path. We copy them as-is from
 * `catalog-data/` and do not author them, so "we fixed it" does not arise the same way,
 * and a package is several files where a starter is one. They keep the offer-once rule.
 */

import type { SkillEval } from "./skill-evals.ts";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { SKILLS_DIR } from "./skills.ts";
import { catalogDataDir, hubSkillSlugs } from "./catalog.ts";
import { templatesEnabled } from "./template.ts";

/**
 * Records what has been offered and which version, so three states stay distinct:
 * never offered, offered and untouched, offered and edited by a person.
 *
 * `<slug> <sha8>` per line. A bare `<slug>`, which is every line a pre-INV-688 marker
 * wrote, means offered with the version unknown — treated as edited, because the
 * conservative reading of "we cannot tell" is "leave it alone".
 */
export const SEEDED_MARKER = ".seeded";

/** Eight hex characters of the content. Long enough here; this is change detection. */
export function skillDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/** What the marker says, by slug. `undefined` means offered with no version recorded. */
export function markerEntries(markerText: string | undefined): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const line of (markerText ?? "").split("\n")) {
    const [slug, digest] = line.trim().split(/\s+/);
    if (slug !== undefined && slug !== "") out.set(slug, digest);
  }
  return out;
}

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
  for (const slug of markerEntries(markerText).keys()) offered.add(slug);
  return starters.map(starter => starter.slug).filter(slug => !offered.has(slug));
}

/**
 * Which already-present starters are worth looking inside the box for.
 *
 * Only the ones whose content we have changed since we last wrote it. Everything else is
 * either absent, or identical to what we would write, and reading it would answer a
 * question nobody asked at the cost of a round trip each.
 */
export function needsInspection(
  markerText: string | undefined,
  existing: readonly string[],
  starters: readonly StarterSkill[] = STARTERS
): string[] {
  const marker = markerEntries(markerText);
  const present = new Set(existing);
  return starters
    .filter(skill => present.has(skill.slug) && marker.has(skill.slug))
    .filter(skill => marker.get(skill.slug) !== skillDigest(skill.content))
    .map(skill => skill.slug);
  // Note: an entry with no recorded digest is included, which is what lets `supersedes`
  // recognise a pre-marker copy. That read is the entire cost of the mechanism.
}

/** The past versions a starter claims, for tests and for anyone auditing the claim. */
export function starterSupersedes(slug: string): readonly string[] | undefined {
  return STARTERS.find(skill => skill.slug === slug)?.supersedes;
}

export interface SeedingPlan {
  /** Never offered: write it. */
  seed: string[];
  /** Offered, untouched since, and we have a newer version: replace it. */
  update: string[];
  /**
   * Offered and edited by somebody. Left alone, and named — a silent skip is as bad as a
   * silent overwrite, and this is the one case where a person is owed a sentence.
   */
  keptLocal: string[];
}

/**
 * The three-way decision, as a pure function over what the box said.
 *
 * `inBox` is the current `SKILL.md` text for the slugs `needsInspection` asked about.
 * A slug missing from it is one we could not read, which is treated as edited: we do not
 * overwrite what we could not look at.
 */
export function seedingPlan(input: {
  markerText?: string;
  existing: readonly string[];
  starters?: readonly StarterSkill[];
  inBox?: ReadonlyMap<string, string>;
}): SeedingPlan {
  const starters = input.starters ?? STARTERS;
  const marker = markerEntries(input.markerText);
  const present = new Set(input.existing);
  const plan: SeedingPlan = { seed: [], update: [], keptLocal: [] };

  for (const skill of starters) {
    const offered = marker.has(skill.slug) || present.has(skill.slug);
    if (!offered) {
      plan.seed.push(skill.slug);
      continue;
    }
    // Offered before. Deleted on purpose stays deleted — that is the rule this file has
    // always protected, and it outranks having a newer version.
    if (!present.has(skill.slug)) continue;
    const ours = skillDigest(skill.content);
    const recorded = marker.get(skill.slug);
    if (recorded === ours) continue;
    const current = input.inBox?.get(skill.slug);
    const currentDigest = current === undefined ? undefined : skillDigest(current);
    // Untouched since we wrote it, and we have changed it since: ours to update.
    //
    // Two ways of knowing it is untouched. The marker, which is the ordinary one; and the
    // skill naming one of its own past versions, which is how a box seeded before the
    // marker carried versions still gets a fix.
    const isOurs =
      currentDigest !== undefined &&
      (currentDigest === recorded || (skill.supersedes ?? []).includes(currentDigest));
    if (recorded !== undefined && currentDigest === recorded) {
      plan.update.push(skill.slug);
    } else if (isOurs && currentDigest !== ours) {
      plan.update.push(skill.slug);
    } else if (current !== undefined && currentDigest === ours) {
      // Already what we would write, by whatever route. Nothing to do but record it.
      continue;
    } else {
      plan.keptLocal.push(skill.slug);
    }
  }
  return plan;
}

interface StarterSkill {
  slug: string;
  content: string;
  /**
   * Digests of our own earlier versions of this skill, which we may replace.
   *
   * The marker records what we wrote from now on, but every box seeded before that has a
   * marker of bare slugs and no way to tell our stale copy from somebody's edit. The
   * conservative reading is "leave it alone", and that would have left the first box this
   * mechanism was built for holding a skill that cannot run.
   *
   * So a starter may name versions it knows are its own. Matching one is proof the file is
   * ours and untouched, whatever the marker forgot. Deliberately an allow-list of exact
   * digests and not a heuristic: we claim authority only over bytes we can name, and a
   * version nobody listed stays the owner's.
   */
  supersedes?: readonly string[];
}

const STARTERS: readonly StarterSkill[] = [
  {
    slug: "research-brief",
    // The description before INV-693 said what it does and not when; the live evals showed it
    // was not opened for its own requests. This is that version, which we may replace.
    supersedes: ["9739e713"],
    content: `---
name: research-brief
description: Use when someone asks you to research or look into a topic (调研, 研究一下, 查一下) and wants a written, sourced brief. Search, read primary sources, write the brief to the work directory. Not for a table or file they handed you (data-brief), nor the day's package (daily-research-digest).
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
    // The description before INV-693 said what it does and not when; the live evals showed it
    // was not opened for its own requests. This is that version, which we may replace.
    supersedes: ["63e35309"],
    content: `---
name: study-a-corpus
description: Use when you are handed a large body of documents — a dataroom, an archive, a folder of reports (资料库, 一堆文件, 先通读) — and will be asked about it again and again. Read it once and leave notes that make every later question cheap. Not for one file or a web topic.
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
    // The description before INV-693 said what it does and not when; the live evals showed it
    // was not opened for its own requests. This is that version, which we may replace.
    supersedes: ["50670d80"],
    content: `---
name: tidy-downloads
description: Use when someone asks to tidy, clean up or organise their Downloads folder (整理下载, Downloads 太乱了). Sort it into the work directory by type and month.
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
    slug: "daily-research-digest",
    // The version shipped on 2026-09-24, which told the agent to read a host path the box
    // cannot see and to run a command the box does not have. Named here so a box already
    // holding it gets the fix instead of being asked whether it edited a file it did not.
    supersedes: ["5e8ec37f"],
    content: `---
name: daily-research-digest
description: Read one day's package and write one synthesis across it, organised by what the day was about rather than by what arrived.
scope: global
---

# Daily research digest

A day's package is at \`/home/box/work/digest/<runKey>/package/\`. It holds every message
whole, every turn, every source that was read, and every reply — assembled on the host and
delivered here, redacted, bounded to one day. Take the newest one with a \`READY\` file beside
it; without \`READY\` the package is still arriving and is not yours to read yet.

Your job is the one thing the package cannot do for itself.

**Write a synthesis, not a list.** The day's items are the input, never the outline. If a
reader can tell from your headings what order things arrived in, you have written the wrong
document, and \`agentbox digest validate\` will say so and refuse it.

## Before you write

1. Read \`manifest.json\`. If \`gaps\` is not empty, **the first line of the digest says what
   is missing and why** — a thin day and a day nobody could see look identical otherwise.
2. Read every message. All of them, not a sample: the point of the package is that it is
   complete.
3. Read the sources under \`sources/\`. They are what was actually read, at the time, with
   their completeness recorded. A source marked \`expired\` has only its row left; say so
   rather than guessing at what it said.

## The synthesis, in three passes

**Themes.** Propose candidate themes first. Then write down what would put a message *in*
each one. Then go back over **every** message and place it. Grouping as you read produces
the order you read in, which is the failure this whole document exists to avoid. A theme
needs **at least two different sources** — two messages about the same link is one source,
not two. A theme with one source is an observation; put it under the main thread instead.

**Tensions, as a separate pass.** Go through the day again looking only for places the
material pulls against itself: two sources disagreeing, a claim that weakened, something
the day's own evidence does not support. This has to be its own pass. Tensions noticed in
passing never get written down.

**What changed.** Only against a real baseline: the previous day's \`themes.json\`. Mark a
theme \`NEW\`, \`STRENGTHENED\` or \`CONTRADICTED\` only if you can point at yesterday's entry.
No baseline means no verbs — say "first day with a baseline" and move on.

## Citations

Every sentence that makes a claim carries at least one:

- \`[msg:<id8>]\` — a person said this
- \`[source:<sha8>]\` — this was read, and the bytes are in the package
- \`[turn:<id8>]\` — your own analysis, and it **must** be in a sentence that also carries a
  \`[msg:]\` or a \`[source:]\`. Your own reasoning is not the evidence for your own reasoning.

Quote only when the wording is the source's, character for character. A near quotation is
reported as near, not as a quotation.

## Output

1. \`draft.md\` in the package directory: the full digest.
2. \`themes.json\` beside it — \`{"themes": ["…"]}\`, this day's theme names, for
   tomorrow's baseline. Without it tomorrow may not say NEW or STRENGTHENED about anything.
3. Reply with the short version, **600 characters at most**: the main thread, the theme
   names, the tensions, what changed. The appendix is an index and not the text — one line
   per message, and the reader opens the package if they want more.

The host checks what you wrote — that every citation resolves, that no sentence leans only
on your own turn, and that the digest is not a list — and sends it back with what to fix
if it does not hold. You do not run that check yourself; it reads \`draft.md\` from here.

A day with one real thing in it gets a short digest about that thing. Padding a thin day
into the shape of a full one is worse than saying it was thin.
`,
  },
  {
    slug: "weekly-retro",
    // The description before INV-693 said what it does and not when; the live evals showed it
    // was not opened for its own requests. This is that version, which we may replace.
    supersedes: ["6200edf5"],
    content: `---
name: weekly-retro
description: Use when someone asks for a weekly retro, review or recap of the last seven days (周报, 这周的复盘, weekly review). Write one page to the work directory. For yesterday alone, use morning-summary.
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
    // The description before INV-693 said what it does and not when; the live evals showed it
    // was not opened for its own requests. This is that version, which we may replace.
    supersedes: ["13498819"],
    content: `---
name: code-review
description: Use when someone asks you to review a change, a diff, a PR or some code (review, 代码评审, 看一下这个改动) for correctness, security and tests. Write the review to a file; do not rewrite the code. Not for a request to change the code itself.
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
    // The description before INV-693 said what it does and not when; the live evals showed it
    // was not opened for its own requests. This is that version, which we may replace.
    supersedes: ["bb96a447"],
    content: `---
name: wechat-longform
description: Use when someone asks for a WeChat official-account article or any long-form article (公众号文章, 长文, 推文). Draft it to the work directory, sourced and readable aloud. Short notes are xiaohongshu-note; spoken scripts are short-video-script.
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
    // The description before INV-693 said what it does and not when; the live evals showed it
    // was not opened for its own requests. This is that version, which we may replace.
    supersedes: ["32528bb8"],
    content: `---
name: short-video-script
description: Use when someone asks for a short-video or voice-over script (短视频脚本, 口播, 抖音, 视频号, Reels). Write a spoken script with a timed hook, one point and one ask. Written notes are xiaohongshu-note; articles are wechat-longform.
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
    // The description before INV-693 said what it does and not when; the live evals showed it
    // was not opened for its own requests. This is that version, which we may replace.
    supersedes: ["d09a4b36"],
    content: `---
name: data-brief
description: Use when someone hands you a table — csv, xlsx, a folder of sheets — and asks what it says (看数据, 分析这个表, 数据简报). Check data quality first, then answer with figures tied to columns, and end with actions. For a topic with no table, use research-brief.
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
    // The conduct half of INV-692. The host checks the outbox mechanically (does it open, is it
    // what its name says, is a template slot left); this is what a mechanical check cannot do.
    slug: "check-before-delivering",
    content: `---
name: check-before-delivering
description: Before handing a person a file you made (docx, xlsx, pptx, pdf, csv, an image), open the result and check it against the request. Not for plain chat answers with no file.
scope: global
---

# Check before delivering

The script that wrote a file ran without an error. That says nothing about whether the
file is right. Check the file, not the code that made it.

1. **Open what you made, fresh.** Read the file back from disk the way the person will
   get it: unzip a docx/xlsx/pptx and read the text, open a PDF and read a page, render a
   chart or slide to PNG and look at it. Do not reason from what the code should have
   produced.
2. **Is it the format its name says?** A .docx must be written by something that writes
   Word files — never markdown with a new extension. Same for .xlsx and .pptx.
3. **Hold it against the request, point by point.** Every question asked has an answer in
   the file; every figure the person gave you is there as they gave it; nothing is from a
   different file or an older draft.
4. **Nothing unfinished.** No {{name}}, no [插入…], no lorem ipsum, no "TBD" where a
   value belongs, no empty sheet, no slide with a title and nothing under it. If a slot is
   meant to stay open (they asked for a template), say so in your reply.
5. **Then deliver.** Put it in this chat's outbox/ and say in one or two sentences what it
   is and what is in it.

If the same problem survives three fixes, stop and tell the person what is stuck and what
you tried. A late honest answer is better than a broken file on time.
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

/**
 * What each starter is for and not for, as cases a live run can check (INV-693, skill-evals.ts).
 *
 * Beside the starters rather than inside their text, so a case can change without changing the
 * bytes a box was seeded with — the digest in `.seeded` is of the content alone. Each no-trigger
 * case is a request that belongs to a neighbour, because the confusable neighbour is where a
 * description drawn too wide shows first.
 */
const STARTER_EVALS: Record<string, readonly SkillEval[]> = {
  "research-brief": [
    { name: "topic brief", kind: "trigger", says: "帮我调研一下固态电池过去一年的进展，给我一份带来源的简报。" },
    { name: "a table is data-brief", kind: "no-trigger", instead: "data-brief", says: "这是 /home/box/work/sales.csv，按区域看一下表现，先查数据质量，最后给建议。", files: { "/home/box/work/sales.csv": "region,month,revenue\nnorth,2026-07,120\nsouth,2026-07,95\n" } },
  ],
  "study-a-corpus": [
    { name: "dataroom first", kind: "trigger", says: "/home/box/work/dataroom 里有三百份合同和报告。先通读一遍，接下来一周我会问你很多问题。", files: { "/home/box/work/dataroom/contract-001.md": "Master services agreement between A and B…", "/home/box/work/dataroom/report-q2.md": "Q2 operating report…" } },
    { name: "a web topic is research-brief", kind: "no-trigger", instead: "research-brief", says: "帮我查一下这周 AI 芯片有什么新闻，写个简报。" },
  ],
  "tidy-downloads": [
    // With a Downloads folder to find: the first live run had none, and the agent spent its budget searching the disk for one [infra].
    { name: "messy downloads", kind: "trigger", says: "我的 Downloads 文件夹太乱了，帮我整理一下。", files: { "/home/box/Downloads/invoice-2026-08.pdf": "%PDF-1.7\n%%EOF\n", "/home/box/Downloads/IMG_2041.jpg": "jpeg", "/home/box/Downloads/notes (1).txt": "draft" } },
    { name: "yesterday's changes are morning-summary", kind: "no-trigger", instead: "morning-summary", says: "总结一下昨天 work 目录里都改了什么，写成一条早上看的笔记。" },
  ],
  "morning-summary": [
    { name: "yesterday's changes", kind: "trigger", says: "总结一下昨天 work 目录里都改了什么，写成一条早上看的笔记。" },
    { name: "a week is weekly-retro", kind: "no-trigger", instead: "weekly-retro", says: "帮我写一份这周的复盘，一页就行。" },
  ],
  "daily-research-digest": [
    { name: "today's package", kind: "trigger", says: "把今天的日包读一遍，写一份按主题组织的横向综合，不要逐条罗列。" },
    { name: "one topic is research-brief", kind: "no-trigger", instead: "research-brief", says: "帮我研究一下 RISC-V 生态现在发展到哪一步了，写个带来源的简报。" },
  ],
  "weekly-retro": [
    { name: "this week", kind: "trigger", says: "帮我写一份这周的复盘，一页就行。" },
    { name: "yesterday is morning-summary", kind: "no-trigger", instead: "morning-summary", says: "总结一下昨天 work 目录里的变化，给我一条早报。" },
  ],
  "code-review": [
    { name: "review a change", kind: "trigger", says: "帮我 review 一下 /home/box/work/repo 最新的这个改动，重点看安全和测试。", files: { "/home/box/work/repo/src/login.ts": "export function login(user: string, password: string) { return db.query(`SELECT * FROM users WHERE name='${user}'`); }\n" } },
    { name: "a rewrite is not a review", kind: "no-trigger", says: "把 /home/box/work/repo/src/login.ts 直接改成用参数化查询，改完就行。", files: { "/home/box/work/repo/src/login.ts": "export function login(user: string, password: string) { return db.query(`SELECT * FROM users WHERE name='${user}'`); }\n" } },
  ],
  "wechat-longform": [
    { name: "a long article", kind: "trigger", says: "写一篇公众号长文，讲清楚为什么小团队也需要认真做数据备份。" },
    { name: "notes are xiaohongshu", kind: "no-trigger", instead: "xiaohongshu-note", says: "帮我写几条小红书笔记推荐露营装备，要标题、封面文案和正文。" },
  ],
  "xiaohongshu-note": [
    { name: "camping notes", kind: "trigger", says: "帮我写几条小红书笔记推荐露营装备，要标题、封面文案和正文。" },
    { name: "a spoken script is short-video", kind: "no-trigger", instead: "short-video-script", says: "写一个 60 秒的抖音口播脚本，讲露营装备怎么选，开头三秒要抓人。" },
  ],
  "short-video-script": [
    { name: "sixty seconds", kind: "trigger", says: "写一个 60 秒的抖音口播脚本，讲露营装备怎么选，开头三秒要抓人。" },
    { name: "an article is wechat-longform", kind: "no-trigger", instead: "wechat-longform", says: "写一篇公众号长文，讲清楚为什么小团队也需要认真做数据备份。" },
  ],
  "data-brief": [
    { name: "a sales table", kind: "trigger", says: "这是 /home/box/work/sales.csv，按区域看一下表现，先查数据质量，最后给建议。", files: { "/home/box/work/sales.csv": "region,month,revenue\nnorth,2026-07,120\nsouth,2026-07,95\n" } },
    { name: "competitor pricing is research", kind: "no-trigger", instead: "research-brief", says: "调研一下三家主要竞品的定价策略，给我一份带来源的简报。" },
  ],
  // For the starter INV-692 adds (PR #237). Keyed by slug, so it waits here until that starter
  // exists, and whichever of the two lands second does not turn the coverage guard red.
  "check-before-delivering": [
    { name: "a file to hand over", kind: "trigger", says: "把 /home/box/work/q3.csv 这份季度数据整理成一个 Excel 表格发给我。", files: { "/home/box/work/q3.csv": "region,revenue\nnorth,120\nsouth,95\n" } },
    { name: "a plain answer has no file", kind: "no-trigger", says: "北京今天适合出门跑步吗？一句话回答就行。" },
  ],
  "export-template": [
    { name: "share yourself", kind: "trigger", says: "把你自己打包成一个模板吧，我想分享给同事用。" },
    { name: "exporting a file is not a template", kind: "no-trigger", says: "把 /home/box/work/report.md 导出成 PDF 发我。", files: { "/home/box/work/report.md": "# Q3 report\n\nRevenue grew 12%.\n" } },
  ],
};

/** Every starter with its text and its cases: for the coverage guard and the live run. */
export function starterSkillsWithEvals(): readonly { slug: string; content: string; evals: readonly SkillEval[] }[] {
  return STARTERS.map(starter => ({ slug: starter.slug, content: starter.content, evals: STARTER_EVALS[starter.slug] ?? [] }));
}

export interface SeedingResult extends SeedingPlan {
  /** Hub packages seeded this run, which follow the offer-once rule. */
  hub: string[];
}

/**
 * Writes whichever starter skills this box has never been offered, and replaces the ones
 * we have since fixed and nobody has touched.
 */
export async function seedStarterSkills(
  box: {
    listDir: (path: string) => Promise<{ entries: { name: string }[] }>;
    uploadFile: (path: string, base64: string) => Promise<unknown>;
    readFile?: (path: string) => Promise<{ content: string }>;
    exec: (
      command: string,
      options?: { timeoutMs?: number; actor?: string }
    ) => Promise<unknown>;
  },
  log: (line: string) => void
): Promise<SeedingResult> {
  const nothing: SeedingResult = { seed: [], update: [], keptLocal: [], hub: [] };
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
    // The export skill only where sharing is on: a box with AGENTBOX_TEMPLATES=0 has no tool for
    // the skill to end in, and a recipe that ends nowhere teaches the wrong thing.
    const starters = STARTERS.filter(skill => skill.slug !== "export-template" || templatesEnabled());
    const missing = unseededStarters(markerText, existing, [
      ...starters,
      ...hub.map(slug => ({ slug })),
    ]);

    // Look inside the box only for starters we have changed since we last wrote them.
    // A starter we have not touched needs no round trip to confirm it is still itself.
    const inBox = new Map<string, string>();
    for (const slug of needsInspection(markerText, existing, starters)) {
      const read = await box.readFile?.(`${SKILLS_DIR}/${slug}/SKILL.md`).catch(() => undefined);
      if (read !== undefined) inBox.set(slug, read.content);
    }
    const plan = seedingPlan({ markerText, existing, starters, inBox });
    const hubMissing = hub.filter(slug => missing.includes(slug));
    const writing = [...plan.seed, ...plan.update];

    // Said even when there is nothing else to do: a person whose edit is holding back a
    // fix is owed that sentence every time, not once.
    for (const slug of plan.keptLocal) {
      log(
        `starter skill ${slug} has a newer version, and yours is edited — left alone. ` +
          `Delete ${SKILLS_DIR}/${slug}/SKILL.md to take ours.`
      );
    }
    if (writing.length === 0 && hubMissing.length === 0) {
      return { ...plan, hub: [] };
    }

    // Upload refuses a parent that does not exist — the same refusal that stops a
    // stray upload inventing directory trees — so the directories are made first,
    // deliberately, through the shell.
    const dirs = [...new Set([...writing, ...hubMissing])].map(slug => `${SKILLS_DIR}/${slug}`).join(" ");
    if (dirs !== "") {
      await box.exec(`mkdir -p ${dirs}`, { timeoutMs: 15_000, actor: "host:starter-skills" });
    }
    for (const skill of starters) {
      if (!writing.includes(skill.slug)) continue;
      await box.uploadFile(
        `${SKILLS_DIR}/${skill.slug}/SKILL.md`,
        Buffer.from(skill.content, "utf8").toString("base64")
      );
    }
    for (const slug of hubMissing) await seedHubSkill(box, slug);

    // The marker records everything offered as of now, and which version: what it already
    // said, what was on disk (a pre-marker install has skills the marker never heard of,
    // and deleting one of those should also stick), and what was just written.
    //
    // A slug we left alone keeps whatever version the marker had, including none. Writing
    // ours against a file that is not ours would make the next run believe it had been
    // edited back, and the loop would never settle.
    const byContent = new Map(starters.map(skill => [skill.slug, skill.content]));
    const starterSlugs = new Set([...byContent.keys(), ...hub]);
    const offered = markerEntries(markerText);
    for (const name of existing) if (starterSlugs.has(name) && !offered.has(name)) offered.set(name, undefined);
    for (const slug of hubMissing) offered.set(slug, undefined);
    for (const slug of writing) offered.set(slug, skillDigest(byContent.get(slug) ?? ""));

    await box.uploadFile(
      `${SKILLS_DIR}/${SEEDED_MARKER}`,
      Buffer.from(
        `${[...offered.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([slug, digest]) => (digest === undefined ? slug : `${slug} ${digest}`))
          .join("\n")}\n`,
        "utf8"
      ).toString("base64")
    );

    if (plan.seed.length > 0) {
      log(`seeded ${plan.seed.length} starter skill(s) into ${SKILLS_DIR}: ${plan.seed.join(", ")}`);
    }
    if (hubMissing.length > 0) log(`seeded ${hubMissing.length} skill package(s): ${hubMissing.join(", ")}`);
    // Named separately from seeding, because replacing a file somebody already has is a
    // different event from giving them one they never had.
    if (plan.update.length > 0) {
      log(`updated ${plan.update.length} unedited starter skill(s): ${plan.update.join(", ")}`);
    }
    return { ...plan, hub: hubMissing };
  } catch (error) {
    // A box without starter skills still works; the person just starts from blank.
    const detail = error instanceof Error ? error.message : String(error);
    log(`could not seed starter skills: ${detail}`);
    return nothing;
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
