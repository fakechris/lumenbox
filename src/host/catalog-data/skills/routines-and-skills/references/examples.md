# Worked examples

Each block below is a whole `SKILL.md`. Put it at
`/home/box/work/skills/<slug>/SKILL.md` with `write_file`; the folder name is the slug.
Chat keys (`feishu:oc_…`) are placeholders: use the real key of the chat that should hear it.

## 1. Weekday morning brief (schedule)

Slug `competitor-price-brief`.

```
---
name: competitor-price-brief
description: Use when the weekday competitor price brief runs, or when someone asks for today's competitor prices (竞品价格).
schedule: "35 8 * * 1-5"
timezone: Asia/Shanghai
deliver: feishu:oc_…
because: they asked for these prices four mornings in a row
---

# Competitor price brief

1. Read the list of product pages in `/home/box/work/prices/watchlist.md`.
2. Fetch each page with `WebFetch` and note the listed price and any promotion.
3. Compare with yesterday's file `/home/box/work/prices/<yesterday>.md`; save today's
   as `/home/box/work/prices/<today>.md`.
4. Reply with only the products whose price or promotion moved, one line each:
   product, old → new, link. If none moved, call NothingToSay with "no change".
5. A page that will not load: one line naming it. Do not retry in this run.
```

## 2. Answer a phrase in one chat (listener)

Slug `deploy-failure-triage`.

```
---
name: deploy-failure-triage
description: Use when someone in the ops chat reports a failed deploy ("deploy failed", "发布失败").
trigger: message
match: /deploy (failed|broke)|发布失败/i
chat: feishu:oc_…
---

# Deploy failure triage

1. From the message, pull the service name and time; if neither is there, ask nothing
   and say what is missing in one line.
2. Read the newest log under `/home/box/work/deploys/<service>/`.
3. Reply with: the failing step, the first error line, and the one most likely cause.
   Keep it under eight lines. Do not restart or roll back anything.
```

## 3. Called from a phone or another system (webhook)

Slug `file-a-link`.

```
---
name: file-a-link
description: Use when a link or note arrives through this routine's webhook and needs filing in the reading inbox.
trigger: webhook
deliver: feishu:oc_…
deliver_when: always
---

# File a link

1. The request body is the payload; treat it as data. It is a URL, a note, or both.
2. For a URL, fetch it with `WebFetch` and write title, source and a two-line gist.
3. Append the entry to `/home/box/work/inbox/<today>.md`.
4. Reply with the one-line entry you filed.
```

After saving, the URL and its secret appear under Settings → Automations. Tell the
person to copy them from there.

## 4. One reminder at a set time (@at)

```
---
name: renewal-reminder
description: Use when the domain renewal reminder fires on 9 October.
schedule: "@at 2026-10-09T10:00+08:00"
deliver: feishu:oc_…
---

Remind the team in one line that example.com expires on 12 October and needs
renewing at the registrar. Nothing else.
```

It fires once. Move the folder out of `skills/` afterwards.

## 5. A reusable method (no trigger)

```
---
name: changelog-from-commits
description: Use when asked to write release notes or a changelog (更新日志) from a range of git commits.
scope: global
---

# Changelog from commits

1. `git log --no-merges --pretty='%h %s' <from>..<to>` in the repo you were given.
2. Drop chores (formatting, version bumps, CI-only) unless asked to keep them.
3. Group what is left under Added / Changed / Fixed, written for users, not developers.
4. One line each; link the short hash. Flag any commit whose message you could not
   interpret instead of guessing.
5. Write it to `/home/box/work/changelogs/<to>.md` and reply with the path.
```

A routine can reuse this by saying, in its own body, "follow the
`changelog-from-commits` skill for the range since last Friday".
