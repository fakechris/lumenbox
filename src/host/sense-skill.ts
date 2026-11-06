/**
 * The starter skill that looks around on a schedule and proposes what it finds (INV-1652).
 * Kept beside the other starters' list rather than in it because that file is at its ceiling;
 * seeded, updated and left alone by the same rules as the rest.
 */

import type { SkillEval } from "./skill-evals.ts";

/** When it is used and when it is not: the coverage guard reads these with every other starter's. */
export const SENSE_AND_PROPOSE_EVALS: readonly SkillEval[] = [
  { name: "look around and propose", kind: "trigger", says: "看一圈板子、仓库和消息，把需要我注意的事以提案的形式放到任务板上，别直接做。" },
  { name: "a direct ask is not sensing", kind: "no-trigger", instead: "morning-summary", says: "总结一下昨天 work 目录里都改了什么，写成一条早上看的笔记。" },
];

export const SENSE_AND_PROPOSE = {
    slug: "sense-and-propose",
    content: `---
name: sense-and-propose
description: Look around on a schedule and put what needs attention on the board as proposals — a todo, a problem, an opportunity, a decision — each with its source and evidence; a person commits what is worth doing.
scope: global
---

# Sense and propose

You are not being asked to do anything. You are looking around so the person does not have to,
and writing down only what is worth their eye. Nothing you write here is work until a person
commits it on the board.

1. **Look at the board.** \`Tasks\` list. A task in \`doing\` with no change for days, a task
   past its due date, a blocked task nobody answered: each is a *problem*.
2. **Look at the work kernel, if you have it.** If an \`involute\` tool is available, read the
   ready queue and your inbox: an item a person committed that nobody took is a *todo*; a
   question put to our team with no answer is a *decision*.
3. **Look at the repositories you were told to watch** (listed in your standing files; none means
   skip): with \`WebFetch\` on the repository's API, a pull request waiting on review, a failing
   check on the main branch, an issue with no reply. Each is a *problem* or a *todo*.
4. **Look at what you were sent** since you last looked (\`OtherThreads\`): a request nobody
   picked up is a *todo*; something that would help the person that nobody asked for is an
   *opportunity*.

For each finding, one \`Tasks\` create with \`discovery_kind\`, \`source\` (the URL, task id or
chat), \`evidence\` (one line, quoted), \`why_now\` (one sentence), and a \`level\` you think
fits (1 understand, 2 propose, 3 partial, 4 do with confirmation, 5 end to end). The board
refuses a finding it already carries — do not reword it to get past that; a dismissed one
stays dismissed unless the evidence changed.

Reply with one line per proposal and nothing else. If you found nothing, say so in one line.

To run this on a schedule, add five cron fields to the frontmatter above, for example
\`schedule: "0 9,14 * * 1-5"\` (09:00 and 14:00 on weekdays), and \`timezone:\` if the host's
clock is not yours. Nothing runs until you do.
`,
  };
