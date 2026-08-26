# R7: secrets an agent reads land in the record in clear

**Status: design, not built.** Written to be attacked. Per [docs/13](13-design-review.md)
this is the class that goes to hostile review first — it changes a persisted format, it
crosses several components that each already work, and above all **being wrong here looks
exactly like being right**: a redaction that misses reads like one that worked, and a
redaction that eats a real answer reads like the model being stupid.

---

## What was measured, before anything was designed

### 1. On 1.1 MB of this installation's real records, the obvious design is 0% precise

Eleven credential patterns — AWS access-key ids, GitHub PATs, `sk-` keys, Slack tokens,
Google API keys, Feishu app ids, JWTs, PEM private keys, tokens in URL query strings,
`Bearer` headers, and `key = value` assignments — run over every transcript, conversation,
turn log, activity log, inbox and task file.

**Two matches. Both false. No true positives.**

```
url-token       &key=全国中小企业融资综合信用服务平台
assign-secret   apiKey: process.env.XAI_API_KEY
```

The first is a search query in a URL whose parameter happens to be named `key`. The second
is a code snippet demonstrating the *correct* practice — reading the key from the
environment instead of hardcoding it.

This is the finding the whole design turns on. The naive filter does not have a tolerable
false-positive rate on our corpus; it has an **infinite** one, because the denominator is
zero. Shipping it would delete a Chinese search term from a research answer and mangle a
code example about not hardcoding secrets, in exchange for catching nothing that is there.

### 2. No configured secret has leaked into the records

Every string of 16+ characters in `config.json` — the two live credentials this
installation holds — checked verbatim against every record file. **Zero occurrences.**

So the credentials that were pasted into a chat during development went to the operator's
own terminal, not into an agent's transcript. The vault's one strong property is intact,
and the exposure R7 describes is **latent rather than realised**.

### 3. The existing redaction covers one field

`browser-snapshot.ts` blanks `<input type=password>` values. That is the narrowest
possible version of this: it protects the one place a secret is *typed*, and nothing about
the places a secret is *read*.

---

## What that changes about the ranking

R7 has been described as the heaviest item and as growing on its own. Both remain true of
the **exposure**. Neither is now true of the **urgency of a filter**, because the filter is
the part that does not work.

The honest reading of the measurements: this is a *containment* problem, not a
*detection* problem. Detection is the approach that is measurably wrong.

---

## The threat surface, enumerated

Where third-party or secret-bearing text reaches a durable record:

| path | how it arrives | today |
|---|---|---|
| `bash` stdout | `cat .env`, `env`, `git remote -v` with a token in the URL, a build log echoing a key | first 2 KB in the transcript, **the whole thing in the box spool** |
| `read_file` | the agent opens a `.env`, a `~/.aws/credentials`, a private key | in the transcript |
| `WebFetch` | an API response with a token, a page with a key in a URL | in the transcript |
| browser snapshot / `browser_read` | `href` with a token in the query string, a page body | in the transcript; password *inputs* redacted |
| MCP tool results | anything a third-party server returns | in the transcript, same as any tool |
| channel messages | a person pastes a key into the chat | in the transcript |
| `RunOnHost` | the vault resolves a real secret | **never enters the box**; audited by name |

Two amplifiers make each of these worse than a line in a file:

- **Backups copy everything.** `backup.ts` already says so in a comment: the credentials
  keep their 0600, "the transcripts do not, and a transcript is where a secret an agent
  read ends up."
- **The spool holds what the transcript truncated, and ships out with upgrade backups.** A
  2 KB transcript remnant points at a full-output file in the box. The truncation is not
  containment; it is a pointer — and `./.spool/` is present in the volume archive taken by
  this afternoon's `box up --recreate`.

---

## Three designs, and why two are rejected

### A. Pattern redaction at the boundary — rejected on our own data

Scan every tool result for credential shapes; replace matches with `<redacted>`.

Rejected because of measurement 1. It is not that the precision is imperfect; it is that
on 1.1 MB of real traffic it produced only false positives. And the failure is
asymmetric in the worst direction: a missed secret is silent, while a false positive is
also silent — the agent simply gets a mangled document and reasons from it. Both failures
look like nothing happening.

Widening the patterns raises the false-positive rate. Narrowing them guarantees the
misses. This is the same trap as the regex grader in `golden.ts`, which failed a correct
answer within an hour of being written, and the rule that came out of that applies
unchanged: **the harness asserts what it can observe or planted itself; anything requiring
an understanding of what text means is not a pattern's job.**

Kept from it: a *small* set of structurally unambiguous forms is worth having — `-----BEGIN
… PRIVATE KEY-----`, `AKIA[0-9A-Z]{16}`, `ghp_…`. These have no legitimate reading. They
are worth an alert, not a rewrite; see D below.

### B. Model-judged redaction — rejected on cost and on trust

Ask a cheap model "does this contain a secret?" before storing.

Rejected because it puts a model call on every tool result (cost and latency on the hot
path), because the judge sees the secret in order to judge it (the leak now has one more
place to be), and because a judge that is wrong is wrong silently — the same failure shape
as A, with a bill.

### C. Containment: keep the value out of the record in the first place

The vault already proves this shape works for the one case it covers: `RunOnHost` resolves
a named secret on the operator's machine, the value never enters the box, and the audit log
records the *name* and the decision rather than the value.

The design is to extend that principle outward instead of building a filter:

1. **Known values are replaced by their names, not detected.** The vault knows its own
   secrets exactly. Any tool result containing a vault value verbatim has that span
   replaced with `<vault:NAME>` before it is stored. Zero false positives by construction —
   there is no pattern, only equality against strings we already hold. This is the entire
   detection story, and it is exact.
2. **Files that are credentials by convention are refused a body, not scrubbed.**
   `read_file` and `bash` on `.env`, `~/.aws/credentials`, `~/.ssh/id_*`, `*.pem`,
   `.netrc`, `kubeconfig` answer with the file's *shape* — that it exists, its size, which
   keys it defines — and not its values. An agent that needs the value needs `RunOnHost`,
   which is where the vault already sends it. A refusal is loud; a scrub is silent.
3. **The spool is the containment boundary, and it currently leaks past it.** Full command
   output lives in the box and is pointed at rather than copied — the right shape. But
   `/home/box/work/.spool` sits inside the `work` volume, and `box up --recreate` tars that
   whole volume into `~/.agentbox-backups/`. Verified in the backup taken by this
   afternoon's upgrade: `./.spool/` is in the archive. So the untruncated output of every
   command an agent ran — the part the transcript deliberately did *not* keep — travels
   out of the box with every upgrade.

   This is the one place in the design where a concrete thing is broken today rather than
   latent, and the fix is small: exclude `.spool` from `backupVolumes`, and let `reapSpool`
   remain the only thing that outlives a command. *(An earlier draft of this document
   asserted the spool was already excluded. It is not. The claim was written from the
   module comment saying the box is disposable, and checked afterwards — which is the
   failure mode this whole document is about.)*
4. **URL query strings lose their credential-named parameters when a URL is *recorded*.**
   `?access_token=…` → `?access_token=<removed>`, applied to the URL as a structured
   object, not to prose. Parsing a URL is exact where matching prose is not — this is the
   `key=中文` false positive's cure: that string was in a URL, and a URL parser knows the
   difference between a query parameter and a sentence.

### D. Alongside C: alert, do not rewrite

For the handful of structurally unambiguous forms in A, and for a vault value found
anywhere unexpected: **say so, and keep the text intact.** A line in the activity log —
"a private key block was stored in agent X's transcript at «time»" — lets a person rotate
the credential, which is the only remedy that actually helps once a secret has been read.
Rewriting the transcript does not un-read it.

This is the same argument as the ingress ledger: the value of the record is that somebody
can find out what happened, and silently altering it destroys that.

---

## What this design does not do, stated plainly

- **It does not stop an agent reading a secret.** It cannot. The agent has a shell as its
  own uid inside the box. Anything reachable by `cat` is reachable.
- **It does not make the transcript safe to publish.** It makes it *less likely* to hold a
  credential, and it names the ones it knows about.
- **It does not detect an unknown secret in third-party text.** Measurement 1 says nothing
  can, at a false-positive rate anybody would accept. This is the design's largest
  admission and the place a reviewer should push hardest.

---

## Blast radius

| where the decision is encoded | migratable afterwards? |
|---|---|
| tool-result storage path (`storableResult`) | yes — changes what future entries hold |
| **existing transcripts on disk** | **no** — already written in clear; only deletion or rotation helps |
| backups already taken | no — same |
| `read_file` / `bash` refusals | yes |
| the vault's value set | yes |

The unmigratable half is why this is worth doing before the corpus grows, and also why the
first action is not code: **rotate what is known to have been exposed** — which, by
measurement 2, is currently nothing in the agent records.

---

## For the reviewer, with the standing instruction to break it

The alternatives already rejected are A and B, with the measurement that killed A. The
revision history is: this is the first design; the entry has been deferred three times on
the grounds that a filter needs designing, and the measurement above is the first evidence
anybody gathered about whether a filter would work.

**Break it with concrete inputs.** Specifically:

1. Name a real secret that C misses and that a person would expect it to catch. C only
   knows vault values and conventional file paths, so the obvious attacks are: a key the
   operator never put in the vault, pasted into a chat; a token inside a JSON API response
   from an MCP server; a credential embedded in a page the browser rendered.
2. Break the exactness claim in C1. What text is equal to a vault value and is *not* the
   secret? (Short values: a vault entry whose value is `admin` would redact the word
   "admin" everywhere. Does C need a minimum length, and what is it?)
3. Break C2's list. Which credential file does not match those globs on a real developer's
   machine, and what does the refusal do to a legitimate task — "read my `.env` and tell me
   which variables it defines" is a reasonable request that C2 partly answers and partly
   refuses.
4. Break D. If an alert names a transcript and a time but the text stays, does the alert
   become a second copy of the problem — a pointer to where the secret is, in a log with
   weaker permissions?
5. Attack the ordering. C1 redacts *before storage*. The value still passed through the
   model's context on the way. Is redaction-at-storage worth anything if the model already
   saw it and can restate it in its own words in the very next entry?

Question 5 is the one this design is least sure about, and a reviewer who answers it
convincingly should be believed over the author.
