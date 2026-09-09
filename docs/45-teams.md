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

A `teams` / `a–z` toggle above the sidebar, remembered per browser. Teams are shown
alphabetically with a count; everything untagged falls into a last "no team" group rather than
disappearing. The toggle hides itself entirely when nothing is tagged: somebody with six agents
and no teams should not be made to look at headings.

## Not done

- **No renaming a team.** Renaming means editing every member; a rename that touches one agent
  and leaves four behind is worse than no rename at all.
- **The toggle is per browser, not per person.** Two people on one installation each choose their
  own, which is right, but a new browser starts at the default rather than at what that person
  chose last time.
- **No filtering.** Grouping is not the same as "show me only this team", and a person with forty
  agents will want the second one.
