<!-- doc: 111-organisation-administration
     title: Administering an organisation: who may do what, what is recorded, and the Admin's console
     family: spec
     status: current
     domain: organisation-administration
     updated: 2026-11-29
-->
# Administering an organisation: who may do what, what is recorded, and the Admin's console

An organisation installation is run by its Admins for people who did not choose them. A member
hands their agent their own sign-ins (docs/109 §1); an Admin can let them in, give them a box,
publish what every box uses, and stop things. This document says what an Admin may and may not
do, what the installation writes down about it, how an Admin uses it, and what is not true yet.

It owns the **organisation's administration and audit**. Who the roles and gates are is
docs/22's (`identity-and-authority`); how people join is docs/109's; what holds off loopback is
docs/106 §5's; how each record is stored is docs/05's. Where this document cites them it does not
restate them. Facts are from `origin/main` at 72bb432f (2026-11-29); §8 says what is not built.

## 1. The trust model

| Party | Trusted for | Not trusted for |
|---|---|---|
| **Admin** | Who is in the organisation and at which role; what the organisation provides (models, channels, quotas, organisation skills and knowledge); stopping and removing things | What is inside a member's personal box: its conversations, memory, files and sign-ins |
| **Member** (driver) | Their own box, their own agents, what they ask for | Anything in a box they are not a member of |
| **Viewer** | Watching what they are shown | Instructing any agent |
| **Agent** | The work it was asked to do, inside its box, under the policy gate | Anything outside its box; acting for a person other than its own |
| **The operator** (whoever runs the server process and holds its home directory) | Everything — they hold the disk | — this is the one party the software cannot constrain; §6 says what they leave behind |
| **The vendor** (DingTalk, Feishu) | Who a person is (sign-in, directory) | What a person may do here (an Admin's activation decides) |

Three rules follow, and every capability in §2 is checked against them:

1. **The box is the boundary, for Admins too.** An Admin enters a personal box only as its owner
   would allow; `mayEnterBox` has no Admin exception (docs/22 §0; `src/box/membership.ts`).
   Seeing that a box exists, its owner, state and size is administration; reading what is in it
   is not.
2. **Nothing the organisation pushes runs in a person's box without that person's yes** — an
   organisation skill's commands, a template's setup, a routine (decided 2026-11-28; docs/109 §5).
3. **Every act that changes who may do what, or reaches into a person's box, is written down**
   in a ledger the Admins cannot edit from the page and the audit export carries.

## 2. What an Admin may do, and may not

### 2.1 May (organisation installation)

| Area | Acts | Recorded (today) |
|---|---|---|
| People | Activate a person or a department (not a department as Admins); approve or dismiss a request; set a role; remove a person; end one sign-in or all of a person's sessions; issue an invite code | Activations: `activations.jsonl`. Roles, removals, sign-outs, invites: **log only** |
| Directory | Sync now; confirm or dismiss a held sync | `activations.jsonl` |
| Channels | Add, edit, remove a door; public address; connectors | **log only** |
| Boxes | See every personal box (owner, state, image, age, quota); stop, keep, delete, recover; update images; limits; attach and detach shared boxes and nodes | **nothing** for personal-box acts; log only for the rest |
| Quotas | Default, per department, per person | **log only** |
| Organisation knowledge | Review, publish, correct | `org-knowledge.jsonl`, `receipts.jsonl` |
| Organisation skills | Publish, update, withdraw, mark required; review members' offers | `org-skills.jsonl` |
| Models and spend | Provider keys, fallbacks, spend limits, push allowance, pausing an agent | `spend-limits.jsonl`; keys **log only** |
| Policy | Rules, scopes, bundles, hooks, the vault's entries (never their values) | Rules: `policy.jsonl`. The rest **log only**; the vault records only reads (`vault-audit.jsonl`) |
| Tokens | Revoke anybody's side-door token | **nothing** |
| Watching | Spend, network events, behaviour audit, guest audit, approvals in every box (`seesAgent`) | — |

### 2.2 May not

| An Admin may not | Enforced by | State |
|---|---|---|
| Enter a personal box, read its conversations, files or memory | `mayEnterBox`, `mayReadBox`, `mayReadAgent` | Holds on the main routes. **Broken** in three places: promoting a memory by version, task receipts, the team-memory review list (INV-2297) |
| Make a personal box theirs | — | **Broken**: transfer accepts the Admin as recipient and records nothing (INV-2298) |
| Run anything in a person's box | No exec route; organisation skills ask the owner (INV-2222, in review) | Holds once #868 merges |
| See a secret's value | `Vault.list()` omits values; export redacts | Holds |
| Act as another person | No impersonation route; tokens are minted for the caller | Holds |
| Activate a department as Admins; remove the last Admin; let a sync remove the last Admin | `activation-routes.ts`, `people-routes.ts` | Holds |

## 3. What is recorded

**One question decides whether an act needs a ledger line:** does it change who may do what, or
reach into somebody else's box? If yes, it is an *audit act*, and an audit act is written to a
ledger with who, what, to whom, when and from where — never a credential — before it takes
effect, and appears in the audit export. The server's log is not a record: it is gone with the
process.

| Ledger | Holds | In the export | Shown to an Admin |
|---|---|---|---|
| `sign-ins.jsonl` | Sign-ins that worked and that failed or were limited, with address and peer | Yes | **No** |
| `desktop-sessions.jsonl` | Who watched or drove which desktop, how long, whether input was sent | Yes | **No** |
| `activations.jsonl` | Activations, requests, enrolment, boxes asked for, leaving, held syncs | **No** | **No** (the route exists) |
| `org-skills.jsonl` | Publish, update, withdraw, require (and, with #868, members' consent) | **No** | **No** (the route exists) |
| `org-knowledge.jsonl`, `receipts.jsonl` | Promotions, decisions, corrections | No | Memory review |
| `policy.jsonl` | Approvals asked, granted, revoked, used; stops; rule loads | Yes | Partly |
| `vault-audit.jsonl` | Each read of a secret by an agent | Yes | **No** |
| `memory-audit.jsonl` | Admin edits and withdrawals of memory | **No** | **No** |
| `network-events.jsonl` | Egress decisions | Yes (current file only) | Yes |
| `usage.jsonl` | Tokens and cost per agent, box, person | Yes | Spend |
| Control plane `audit` table | Every act on the control plane's admin surface | Its own route | Its own page |

**Gaps** (§8): the acts marked *log only* or *nothing* in §2.1; four ledgers missing from the
export; five not shown anywhere; `network-events` rotation drops a generation from the export;
the export is a CLI command on the server with no role of its own and covers one box at a time.

**Retention.** Records are append-only and kept; three are compacted with archives the export
reads (`policy`, `turns`, `ingress`), `usage` keeps 48 hours plus 5,000 lines, `network-events`
keeps one rotated generation. An organisation's retention period is not configurable today.

## 4. How an Admin uses it

| Use case | What the Admin does | What they rely on |
|---|---|---|
| **First day** | Bootstrap with the code and DingTalk (docs/109 step o); set the model key; sync the directory; activate the first department; publish the organisation's skills | Activation progress and estimate (INV-2220 PR 2) |
| **Somebody joins** | Their request appears; activate at a role; their box and agent are made and they are told | The request list; "not told" list |
| **Somebody leaves** | The directory sync ends their sign-in (or the Admin removes them); their box is kept; the Admin hands it to their successor or deletes it after a set time | Leaving rules (docs/109 §3); **a hand-over that respects §1 rule 1** (INV-2298) |
| **A tool for everyone** | Publish a required organisation skill; watch members agree and install; follow up with those who refused | Consent and box status (#868) |
| **Cost** | Set quotas and spend limits; read spend by department and person | Spend page, quotas |
| **Something went wrong** ("who opened X's desktop on Tuesday", "who made this person an Admin", "which agent read the payroll key") | Filter the audit by person, box, act and time; export the window | **An audit view** (not built: §5) and the export |
| **Compliance request** | Export a period, everything in it, with a manifest and digests | The export, extended to the whole organisation (§8) |
| **Suspected compromise** | Sign a person out everywhere; revoke their tokens; rotate a box's token; pause an agent; stop all | Sign-out, token revocation, box token rotation (INV-2204 part 4), stop |

## 5. The Admin's console

The console is the Settings panes an Admin sees (today: Model, Boxes, Channels, Team, Mine,
Memory, Supervision, Guests). It stays inside Settings — the landing page is the agents and the
conversation (the product's rule) — and is organised by the questions an Admin asks, not by the
ledgers:

| Pane | Answers | State |
|---|---|---|
| **People** | Who is in, at which role; who asked; who left; whose box is ready, failed or waiting; who has not been told | Built across Team → People and the directory block |
| **Boxes** | Every box: owner, state, image, quota, sync of organisation skills; stop, keep, delete, hand over | Built; hand-over to be made safe (INV-2298) |
| **Organisation** | Channels, model and keys, quotas, spend limits | Built across Model, Channels and Team |
| **What everyone has** | Organisation skills (with consent status) and organisation knowledge | Built in Team and Memory |
| **Audit** (new) | One time-ordered view of audit acts across ledgers: filter by person (as actor or subject), box, kind of act and time; each line says who, what, to whom, when, from where; export the filtered window | Not built |
| **Security** (new) | Sign-ins failed and limited, sessions per person with "sign out", side-door tokens with "revoke", box tokens with "rotate", the exposure level and what it requires | Partly built in pieces |

Two design rules: an audit line never shows a value a reader could not see otherwise (a secret's
name, never its value; a box's name, never what is in it), and an Admin cannot hide or edit an
audit line from the page.

## 6. The operator

Whoever runs the server holds `AGENTBOX_HOME` and can read everything in it and in the boxes'
volumes. The software does not pretend otherwise. What it does: secrets in the vault and the
control plane's tokens are encrypted with a key kept apart from the data where the deployment
allows (docs/10 S-6); the audit records are append-only files the page cannot change; the export
carries a manifest with evidence digests so a later copy can be checked. An organisation that
needs the operator watched runs the server under its own controls and ships the ledgers off the
machine — the export is the way out.

## 7. What must hold

- Every audit act in §3's sense writes its line before it takes effect; a failure to write
  refuses the act.
- No audit line holds a credential, a secret's value, or the content of a box.
- The export can be produced for the whole organisation for a time window, and a reader can tell
  from its manifest that nothing was removed from the middle of a ledger.
- §2.2's refusals each have a test that an Admin is refused.

## 8. Gaps and the order to close them

| # | Gap | Item |
|---|---|---|
| 1 | An Admin can read a member's agent's memory by promoting it; receipts and the team-memory review are not filtered by box | INV-2297 (bug) |
| 2 | An Admin can transfer a personal box to themselves; personal-box acts record nothing | INV-2298 (bug) |
| 3 | Roles, removals, sign-outs, invites, channels, quotas, keys, scopes, bundles, hooks, vault changes and token mint/revoke are log only | To propose: one administration ledger written by every Admin route |
| 4 | `activations`, `org-skills`, `memory-audit` and the new administration ledger are not in the export; `network-events.1` is not read | Same proposal |
| 5 | The export is per box, CLI only, with no role | To propose: an organisation-wide export, Admin-only, from the page as well |
| 6 | No audit view; five ledgers shown nowhere | To propose: the Audit pane (§5) |
| 7 | Retention not configurable; no off-machine shipping | Later |
| 8 | The rest of R8 (tokens minted and revoked, API decisions) and box token rotation | INV-2204 part 4, in progress |

Items 3–6 are proposed as work once this document is agreed.
