# Catalog data

`skills/` are standard skill-hub packages, copied 2026-08-30 from the WorkBuddy
marketplace snapshot (`doubao/skills-prompts/all-cloud-skills/workbuddy-skills/skills-source`).
Bodies are not rewritten. Frontmatter extra keys our parser ignores.

Five packages are ours, not copied: `site-playbooks`, `errands`, `acting-for-them`,
`routines-and-skills` and `code-work` (2026-10-02). They were written for LumenBox after a
study of Grok Bot 0.63's server-served skills, which carry no licence. Facts are restated and
mapped onto LumenBox's own tools; no text is copied, and an eight-word overlap check against the
source found no shared prose beyond quoted site labels, URLs and API fields. Grok-only mechanics
(voice, Slack channels, in-chat forms that type into a page, cloud agents) were dropped. Each is
one index line with `references/` read on demand, since the index has a budget (`skills.ts`).

`experts/` are our personas. Structure (identity, how they work, skill routing,
boundaries) follows WorkBuddy/Doubao expert packs; the prose is rewritten so it
is standing identity, not a briefing, and does not freeze tool names.

Provenance of each skill package is in that package's own SKILL.md (license,
homepage, description_zh).
