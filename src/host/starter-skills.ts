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
  },
  log: (line: string) => void
): Promise<void> {
  try {
    const listing = await box.listDir(SKILLS_DIR).catch(() => undefined);
    if (listing !== undefined && listing.entries.length > 0) return;
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
