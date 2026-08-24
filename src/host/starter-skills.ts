/**
 * The skills a fresh box starts with.
 *
 * A skill system with zero skills teaches nobody what a skill is — the same blank-page
 * problem the starter team solves for agents. Three recipes, chosen to demonstrate the
 * three shapes a skill takes: a browser procedure, a filesystem procedure, and a
 * procedure written to be scheduled. All generic on purpose: anything tied to one
 * vendor's account belongs to the person who has that account.
 *
 * Seeded only when the skills directory does not exist yet. A person who deleted a
 * starter skill deleted it; reseeding would put it back every restart, which is the
 * config-file-overwrite bug wearing a different coat.
 */

import { SKILLS_DIR } from "./skills.ts";

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
];

/** Uploads the starter skills through the box, when there are none at all. */
export async function seedStarterSkills(
  box: {
    listDir: (path: string) => Promise<{ entries: { name: string }[] }>;
    uploadFile: (path: string, base64: string) => Promise<unknown>;
    exec: (command: string, options?: { timeoutMs?: number }) => Promise<unknown>;
  },
  log: (line: string) => void
): Promise<void> {
  try {
    const listing = await box.listDir(SKILLS_DIR).catch(() => undefined);
    if (listing !== undefined && listing.entries.length > 0) return;
    // Upload refuses a parent that does not exist — the same refusal that stops a
    // stray upload inventing directory trees — so the directories are made first,
    // deliberately, through the shell.
    const dirs = STARTERS.map(skill => `${SKILLS_DIR}/${skill.slug}`).join(" ");
    await box.exec(`mkdir -p ${dirs}`, { timeoutMs: 15_000 });
    for (const skill of STARTERS) {
      await box.uploadFile(
        `${SKILLS_DIR}/${skill.slug}/SKILL.md`,
        Buffer.from(skill.content, "utf8").toString("base64")
      );
    }
    log(`seeded ${STARTERS.length} starter skills into ${SKILLS_DIR}`);
  } catch (error) {
    // A box without starter skills still works; the person just starts from blank.
    const detail = error instanceof Error ? error.message : String(error);
    log(`could not seed starter skills: ${detail}`);
  }
}
