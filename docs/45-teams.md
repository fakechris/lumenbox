<!-- doc: 45-teams
     title: Teams
     family: decision
     status: current
     updated: 2026-09-09
-->
# 45 · Teams

*2026-09-09. Grouping agents once there are too many to scan. Companion to docs/39 (objects a
person can see) and docs/29 (templates and crews).*

## The problem

A template stamps five agents in one go. Do that twice and the sidebar is fifteen names in
alphabetical order, with the five that were made for one job scattered among the rest. The list
stops answering the question a person actually has, which is never "which agent starts with D"
but "where is the group that does the writing".

## Why several teams and not one

The obvious design is a folder: one team per agent, a tree. It is wrong here, and the person who
asked for this said why in the same breath: *有些人可能是身兼多职的* — some people hold several
jobs. The ops agent every project uses genuinely belongs to every project. Filed under one, it
disappears from the others; filed under a "shared" bucket, it disappears from all of them.

So: **an agent has several teams, and appears under each**. A name in two groups is not
duplication to be cleaned up. It is the fact. The same is true of people on two org charts, and
nobody finds that confusing when they read it.

The cost is that the list is longer than the number of agents. That is worth paying: scanning
one group and finding everyone who works on it beats scanning one flat list and finding nobody.

## The agent can see them, which is the point

A tag an agent can set but not see would be a write-only field: asked to "build a media team" it
would have no way to know the concept exists, and the five agents would arrive untagged anyway.
So the prompt carries three things — the agent's own teams, each teammate's in brackets beside
their name in the roster, and one instruction: when you make several agents for one job, give
them all the same team, named for the job in the person's own words.

That is what closes the loop on the case this came from. "用我们的 agents 建一个媒体团队" now
produces five agents tagged `media`, because the agent doing the creating knows that grouping is
a thing, knows what its teammates are grouped as, and is told to name one.

## How an agent gets a team

Three ways, in the order that matters:

1. **Born with one.** `CreateAgent` takes `tags`, and a crew created from a catalog entry is
   tagged with that entry by default. Five agents stamped together are findable together with
   nobody tidying up afterwards — the case this exists for.
2. **Inherited.** An agent that creates a teammate and names no team passes on its own. An agent
   made by the editorial coordinator is editorial until somebody says otherwise, which is nearly
   always right and is the difference between a list that stays organised and one that decays.
3. **Said.** `UpdateAgent` takes `tags` — including on itself, so an agent that notices it has
   become the one doing the writing can say so. A person edits them in the agent's Configure
   dialog, in a Teams field, comma separated; the same field is on the New agent form.

Names are lowercased and spaces become hyphens, so "Editorial", "editorial " and "content team"
do not become three departments. Five teams per agent, 24 characters each. Any language.

## In the list

A `teams` / `a–z` toggle above the sidebar. Teams are shown alphabetically with a count;
everything untagged falls into a last "no team" group rather than disappearing. The toggle hides
itself entirely when nothing is tagged: somebody with six agents and no teams should not be made
to look at headings.

**The arrangement follows the person, not the browser (INV-121, 2026-10-08).** The toggle and
the filter below are stored on the server against the identity the request carries — the
operator with no identity has a seat of their own — so a second browser, or another machine,
starts where that person left off. localStorage keeps an echo for the moment before `/api/me`
answers.

**Filtering is not grouping (INV-120).** Clicking a team's heading shows only its members, under
a line that says *viewing team media · 5* with an *all* link beside it, so a short list is never
mistaken for the whole roster. The filter is a preference like the toggle.

**Renaming a team renames it on every member or on none (INV-119).** An admin's *rename* link on
the heading asks for the new name; the registry checks everything first — the name is usable,
the team exists, no team of the new name exists (merging is not a rename) — then writes each
member's profile, and puts the already-written ones back if a write fails part-way. A refusal
says why in a sentence.

## Not done

- **No team-level permissions.** A team is a label for finding agents, not a boundary; docs/36 is
  where boundaries live.
