# Security backlog

Deferred on purpose, in favour of correctness and long-task success. Written down so the deferral is
a decision with a record rather than something nobody got round to. Each item says what is exposed
today, so a deployment decision can be made with the actual facts.

**The one-line summary of where this stands:** a single-operator box on a laptop is fine. A
multi-tenant deployment on a shared host is not yet, and the three reasons are S-1, S-2 and S-3.

## S-1 — Secrets an agent reads land in the transcript in clear

Was R-08 in [07-review.md](07-review.md), and **the relay does not fix it.** The relay stopped the
*provider* key entering a box; it does nothing about a credential the agent reads while working.

An agent that runs `printenv`, reads a config file, or is shown a password in a page writes it
verbatim into `conversation.jsonl`. That file is mode 644, and the directory is 700 only in the
self-contained topology. Nothing redacts and nothing warns.

Worth being precise about why this is awkward rather than easy: the transcript's value is that it
stores the model's *own* content blocks, unedited, which is what makes an agent's claims checkable
([04-design.md](04-design.md) §6). A redactor that rewrites tool results is editing the evidence.
The shape that probably works is detection plus a marker — store the result, note that it matched a
credential pattern, and let a reader decide — rather than silent removal.

**And the MCP face keeps it so (docs/33, 2026-09-03):** a delegated engine in the box reaches the
host's MCP tools through a per-job route on the web server — a key in the path, a bearer in the
job's environment, exact tool names snapshotted at mint, a lease the host renews from the box's
job list. No MCP credential enters the box; the policy gate runs with `delegated` set (no approval
reuse, no input in the log); every call lands in `delegate-calls.jsonl` with a result digest.
What it does not do: any process in the box runs as the same uid and can read the job's
environment, so a stolen token buys one route's tools for one lease — the box is one trust
boundary, as docs/03 says.

## S-2 — The gateway has no TLS, and the session cookie is the whole session

Said on startup and in [08-control-plane.md](08-control-plane.md) §10, and still true. Anyone on the
path between a person and the gateway has their session. The fix is a TLS terminator in front, which
is deployment rather than code — but until it is documented as *required* rather than recommended,
someone will run it without one.

## S-3 — Identity is a password list

`PasswordListIdentity` compares passwords rather than hashing them with a slow KDF, has no lockout,
no rotation, and no second factor. It is a placeholder that makes the rest of the gateway real, and
the seam for a real provider exists (`IdentityProvider`). It should be replaced before anyone who is
not the operator signs in.

## S-4 — The box trusts the gateway's identity headers completely

`X-Agentbox-User` and `X-Agentbox-Role` are believed because they arrive with a valid UI token
([09-tenancy.md](09-tenancy.md) §4). If the gateway is compromised, every box is. This is the same
dependency the UI token already creates, so it adds no *new* trust — but the better shape is a signed
assertion the box verifies itself, and the seam for it is that identity is read in exactly one place
(`callerOf`).

## S-5 — Budget enforcement is inside the box, so it is advisory

The policy gate runs in the box, which is right for stopping a turn and for asking a person
([policy.ts](../src/host/policy.ts)) — those need to be answered where the person is looking. But it
means a budget is enforced by the thing being billed. A box whose orchestrator was replaced, or which
simply has a bug, keeps spending.

**The relay is the enforcement point that cannot be bypassed**, because it is outside the box and
holds the credential. It measures spend already; it does not yet refuse on it. That is a small change
and the right place for a hard ceiling — the in-box gate stays as the one that can explain itself to
the agent.

## S-6 — The control plane's encryption key sits beside its database

`control.db.key` is minted 0600 next to `control.db`, so a copy of the *file* is not a credential
dump but a copy of the *directory* is. `AGENTBOX_CONTROL_KEY` moves it out and is the right answer for
a real deployment; the default is chosen so encryption is on rather than being something an operator
remembers to turn on.

## S-7 — A private agent is not a boundary, and the word invites the assumption

Stated where it is checked and in [09-tenancy.md](09-tenancy.md) §3.2: everyone in a tenant shares a
filesystem and passwordless sudo, so a determined member reads another's transcript from a shell.
This is accident prevention. The item here is not to fix it — a real boundary is two tenants and two
boxes — but to make sure no UI ever describes it as privacy.

## S-8 — Egress is allow-listed per relay, not per tenant

The egress relay's allow-list is global to the relay process. Two tenants sharing one get the same
list. Per-tenant policy needs the token to name it, the same way the model relay's token names its
upstream.

## S-9 — `hooks.json` is arbitrary command execution from the state directory

Since 0.30 (docs/28 item 9) `~/.agentbox/hooks.json` runs shell commands at PreToolUse,
PostToolUse, Stop and PreCompact, with the orchestrator's privileges, re-read on every mtime
change. That is the design — Claude Code's, kept exactly — and it means *whoever can write
that file runs commands as the operator*. What is exposed today: the file is not signed, and
until R39 nothing checked who could write it.

**Held since R39 (2026-09-02):** the runner refuses a hooks file that is group- or
world-writable, or owned by another uid, logs the refusal, and treats the file as empty
until it is fixed. The same rule covers `~/.agentbox/extensions/*` (docs/34, 2026-09-03),
which is the same thing with a wider api: each file is checked before import and a loose
one is skipped, not loaded. The state directory itself is the operator's (0700 by `agentbox`'s own
mkdir), so the remaining path in is an agent with `RunOnHost` writing the file — which is
the S-1 class of problem (a host command is the operator), not a new one. **Not done, on
purpose:** a signed or hashed allow-list of hook commands. It would let an operator pin
*which* commands may run, at the price of a second file to keep in step; worth it only for
a shared host, where S-2/S-3 are the bigger holes.

## Not on this list, and why

- **Container escape.** The box runs a browser and arbitrary agent commands, and the isolation is
  Docker's. This is described accurately rather than oversold
  ([03-architecture.md](03-architecture.md)); hardening it further (seccomp, gVisor, user namespaces)
  is real work but it is not a *gap between claim and reality*, which is what this list tracks.
- **Prompt injection.** An agent reading a hostile web page can be told to do things. The mitigations
  that exist here are the ones that matter architecturally — a desktop per agent, an owner token per
  desktop, and now consent for named actions. Treating it as a solvable bug would be dishonest.
