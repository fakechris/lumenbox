# Identity boxes: login state as a per-person container (v2)

Status: **design awaiting its second adversarial review.** v1 was rejected as a build plan
on 2026-08-28 — nine fatal findings, four major, and its central premise about a capture
choke point refuted against the code
([reviews/2026-08-28-identity-box.md](reviews/2026-08-28-identity-box.md)). v1 is not kept:
§9 lists what it claimed and what replaced it, which is what a second reviewer needs.

Not estimated. The estimate comes after the review, and the reason is now empirical rather
than procedural: v1 would have taken about two weeks to build wrong.

## 0. The one-paragraph version

One container per person holds their browser logins. The team box holds none. An agent uses
someone's login only under a lease the owner granted, and **the box that would execute the
work refuses it the moment the lease is fenced** — the check lives at the execution point,
not at the caller. Secrets are never in the container: a placeholder is swapped for the real
value at an egress proxy the container cannot bypass. When the owner logs in by hand, every
path that could turn that screen into bytes is closed by an enumerated list, and the owner's
own view is the single named exception.

## 1. Decisions, unchanged and now better supported

1. **The identity boundary is the container boundary.** Measured: one box, one root, `bash`
   reads any browser profile on disk. Not a hardening problem.
2. **Login state belongs to a principal; secret text belongs nowhere.** Reinforced by
   convergent evidence (§3.3): five independent systems arrived at "the secret never enters
   the container; a placeholder is swapped at the edge."
3. **The team box goes login-free, and that is a migration.** Confirmed against code by the
   review: the `.config` volume persists browser logins *by design*
   (`src/box/docker.ts:35-51,421-433`), and `backupVolumes` archives all of it
   (`:620-672`). "重建即干净" is false today and becomes true only after §7 step 7.
4. **Takeover login**: the person types; the agent never sees; the system provably does not
   record.
5. **Single principal first** — but with the machinery Stage B needs, because the review
   showed the deferrals were load-bearing (§6).

## 2. The lesson that reorganises this document

v1 asserted three properties it could not deliver, and the review found each by reading
code rather than argument. The pattern is one thing:

> **v1 placed each control where it was convenient to write, not where the effect happens.**

The privacy flag sat in a service layer while capture happens in five processes, two of
them shell. The lease fence sat in the host router while effects happen inside the box,
mid-batch. The isolation claim sat on a network topology the engine does not honour.

And that last one has since been measured, not just argued. On 2026-08-28 a per-container
Docker network was added to the team box; a container on the default bridge then reached
its daemon at the private-network address anyway, because Docker 29's `DOCKER-FORWARD`
chain accepts forwarding out of every bridge. **A widely believed isolation mechanism did
not isolate on the engine we run on.** Everything below is therefore organised by *where
the enforcement point is*, and every claim of the form "X cannot happen" names the thing
that refuses and how it was tested.

## 3. Prior art this is built from

Surveyed 2026-08-28 across 31 local projects. Three sources carry most of the design; one
candidate is explicitly rejected; one problem has no prior art anywhere.

### 3.1 Topology and egress — qm

`qm/src/sandbox/local-sandbox.ts`: one Docker network per container, minted at create and
removed with it; daemon published `127.0.0.1:0:<port>`. We now do both — and we know from
the measurement above that **the network is a layer, not a boundary**, so it is kept for
engines that honour it and nothing rests on it.

`qm/deploy/egress-proxy/envoy.yaml` + `qm/src/egress-authz-main.ts` (255 lines): Envoy
terminates CONNECT and calls a local decision service per connection, **fails closed**, and
re-checks every *resolved IP* against link-local/loopback/metadata blocks — closing DNS
rebinding. Two details to copy exactly: the Envoy admin interface is a **0600 unix socket,
never a TCP port** (a loopback admin port is reachable from every sandbox via
`CONNECT 127.0.0.1:<port>`, and `/quitquitquit` would drop egress fleet-wide); and
`iptables -A OUTPUT -d 169.254.0.0/16 -j REJECT` as a belt on top of the braces.

### 3.2 Revocation that stops dispatched work — openclaw, centaur, cindy

- **openclaw** `src/secrets/egress-proxy/proxy-server.ts`: subprocesses hold *sentinels*;
  the proxy substitutes the real secret on the way out. Revocation is
  `tokens.delete(runKey(run))` — the process is still alive and still holds the sentinels,
  and they become **inert strings**. Honest gap, inherited: a request already streaming
  completes.
- **centaur** `iron_proxy.rs:737` `wait_for_proxy_principal_applied()`: before a warm
  sandbox is handed to a new principal, poll the proxy until the **applied principal and
  config hash match**, reading the management address off the live pod. The comment names
  the bug: the harness fired its first call ~350ms before a 5s config poll. This is the
  shape of "revoked means acknowledged", not "revoked means we wrote it down".
- **cindy** `auth-adapters.ts:1318`: capture-compare-commit — snapshot owner scope key and
  generation before an async operation, re-capture before committing, refuse if they moved.
  *"A late response cannot clear a newer login, invalidation or owner."*

### 3.3 The convergent primitive

Five independent systems put the secret outside the container and swap a placeholder at an
egress proxy: codex `credential_broker.rs`, centaur `replace_placeholders`, openclaw
sentinels, qm `delivery: "broker"`, hermes `iron_proxy.py`. By this codebase's own rule —
independent convergence is a constraint, not a style — **this is the one thing to build if
only one thing gets built.**

### 3.4 Rejected: forking codex's network-proxy

v1 proposed evaluating a fork. Rejected on evidence: ~17k lines whose threat model is a
single agent process on a developer laptop; all enforcement host-local with no container
concept; unbypassable only because a **seccomp filter EPERMs `connect`/`bind`/`socket`**
(fork the proxy without that and it is a suggestion); CA trust is **11 curated env vars**,
Chromium not among them; **zero browser/CDP awareness**, so `--ignore-certificate-errors`
walks past it; and its own README concedes DNS rebinding. Take two ideas — the credential
broker shape and the seccomp completeness (it denies `io_uring_*` and `process_vm_readv`
because those launder socket ops) — and get topology from qm/centaur.

### 3.5 No prior art: private capture

Two independent sweeps across all 31 projects for secure-input / pause-recording /
private-login found **nothing**. The closest, and instructive because it stops short:
OpenBot's `requestSecret`/`supplySecret` — the bot names a target field ref (*"so a secret
cannot be sent to whichever field happens to have focus"*), the human types into a masked
box, the audit row records label and character count and never the value; and
`computer.control_taken` **refuses** bot actions while a person drives rather than queueing
them, deliberately not policy-gated because *"a rule able to lock somebody out of their own
browser halfway through a login would be a worse failure than anything it prevented."*
But `Page.startScreencast` runs throughout: masking comes from the page's own password
rendering, not from suppressing the stream. **The capture enumeration in §5 has no
precedent and is ours to get right.**

## 4. Enforcement points

The table is the design. Each row names where the refusal lives and how the claim is
tested; anything that cannot be tested from outside the component is not claimed.

| Property | Refusal lives in | Tested by |
| --- | --- | --- |
| Team box cannot drive an identity desktop | the identity daemon's auth on every route **including the WebSocket upgrade** | request from inside the team container to the identity box's address and published port |
| A revoked lease stops the next effect | the identity box, between actions of a batch | slow multi-action batch, revoke mid-flight, assert refusal and that later actions did not run |
| Secrets never in the container | never written there; swapped at the egress proxy | grep the container's env and profile for the secret; unregistered sentinel → refused request |
| Egress restricted to leased origins | egress proxy, fail-closed, re-checked per resolved IP | direct IP, DNS rebind, `file:`/`data:`, and a typed navigation via computer-use |
| The owner's login is not captured | one gate consulted by every enumerated source (§5) | one test per source, plus the inventory guard |
| Only the owner enters login mode | a signed principal session on both HTTP and the RFB upgrade | unauthenticated and wrong-principal attempts on both paths |

**The daemon's own auth is the backstop for the first row, and it already shipped**: on
2026-08-28 boxd's WebSocket upgrade — previously unauthenticated on the premise that only
the host could reach the port — was made to authorise before parsing a path or opening an
upstream socket, with the host carrying the box token on the hop it makes itself. That
premise had been false twice in one day. An identity box inherits the fix and does not
re-acquire the premise.

## 5. Private capture: sources, sinks, and a closable inventory

v1 said "one flag at the choke point every capture path flows through." The review's first
finding is that **there is no such choke point**, and it listed the paths: the X11 executor
captures unconditionally at the end of every action batch (`x11-executor.ts:357-416`) via a
direct ffmpeg `x11grab` (`:843-865`); `start-display` runs **two x11vnc processes and two
websockify processes** (`start-display:262-306`); `record-service` spawns its own ffmpeg and
a recorder **can outlive the daemon that started it** (`:216-276`); `box-doctor` is another
ffmpeg capture site; browser "snapshots" are not screenshots at all but CDP
`Runtime.evaluate` returning DOM text **including input values except recognised password
fields** (`browser-snapshot.ts:146-181`); and a clipboard *write* reads the selection back
to confirm ownership (`clipboard-service.ts:104-116`).

Three consequences:

1. **"Every capture path refuses" is the wrong property.** The owner cannot log in unless
   one sink stays live — their own screen. The property is about **source, sink and
   audience**: owner-private pixels may reach the authenticated owner; agent, model,
   recording, view-only, audit and diagnostic sinks may not.
2. **The gate must be consulted at the last point before bytes exist**, per source, because
   the sources are different APIs in two languages and some are long-running child
   processes started by shell.
3. **The inventory must be closable mechanically**, and not by the technique v1 named. The
   `MODEL_CALLS` guard works because it searches four TypeScript files for one uniform SDK
   expression; capture has neither property. So: **centralise first, then prohibit the raw
   primitives outside an allowlist** — `x11grab`, `xwd`, `x11vnc`, `xclip -o`, CDP
   evaluation — across TypeScript *and* the shell scripts. The test asserts the inventory
   and the sink policy; a new capture path fails it until it declares a sink.

And the state must **fence input, not only observation**. The review's eighth finding: with
capture stopped and input still flowing, the agent's remaining keystrokes land in the
owner's password field and *nobody has a screenshot of it happening*. Entering login mode
therefore: fences new input, drains or aborts acknowledged in-flight actions at the box,
refuses every non-owner input path (computer, browser action, clipboard write, other VNC
drivers — x11vnc runs `-shared` today), **and only then** opens the login UI. OpenBot's
refuse-don't-queue rule applies, with its caveat: the handover must not be able to lock a
person out of their own login.

Persistence: the state survives a daemon restart and recovers **fail-closed**, because a
red light that clears on a crash is worse than none.

## 6. Stage A absorbs what v1 deferred

The review showed the deferrals were not deferrable. Stage A includes, because Stage B
cannot retrofit them:

- **Task identity to the tool layer.** `taskId` reaches the channel and stops there:
  `orchestrator.prompt` has no task parameter and `ToolContext` has no task field, so a
  router cannot select the lease a call belongs to. Without this the lease is decorative.
- **Owner-bound approval records and delivery.** `PendingApproval` carries fingerprint,
  agent, description, time — no owner, no lease. Delivery is `lastAsker`, verified by its
  own test asserting "whoever last drove". Identity is the case where requester and owner
  differ.
- **A narrow export capability.** v1 removed fs-service *and* required host-mediated file
  copying, whose only client method calls `/fs/download` — a route it had just deleted. A
  fixed-directory, read-once export service is Stage A machinery.
- **Execution-local origin enforcement.** Deferring it to Stage B means Stage A routes
  actions into a logged-in browser with no origin restriction at all.
- **A two-principal test fixture**, since acceptance condition 6 requires two.

## 7. Build order

1. Identity image as a **positive manifest**, not a subtraction: no terminal or file
   manager, no desktop execution launchers, no shells or interpreters not needed at
   runtime, Chrome policy for extensions/devtools/downloads/external protocols/dangerous
   schemes. v1's "an absent binary cannot be talked into it" named absent *services* while
   the image ships a Terminal launcher on the dock — computer-use is a shell surface.
2. Provisioner, registry, own network, loopback publication, daemon auth (inherited).
3. Capture inventory + sink policy + the prohibition test (§5), then `login_private` with
   input fencing, the visible red state, and the recording gap marker.
4. Takeover login behind a **signed principal session**, checked identically on the HTTP
   page and the RFB upgrade — and the noVNC route keyed by `{principal, identityBoxId,
   display}`, because today's route is a display index with no box selector.
5. Lease table (durable, monotonic epoch) + **execution-local fence inside the identity
   box**, checked between actions of a batch and immediately before CDP dispatch, with
   centaur's acknowledged-before-proceeding barrier and cindy's compare-at-commit.
6. Egress proxy, fail-closed, origin-scoped, per-resolved-IP.
7. Migration: login state out of the team box's `.config`; archives exclude identity
   volumes; **legacy profile removal tested from a fixture containing known cookie
   stores**, because a fresh archive proves nothing about an upgraded one.
8. Restart protocol: fence all pre-crash epochs before accepting work, reconcile each box,
   record restore-versus-revoke per lease, re-arm expiry, recover login state fail-closed.

Snapshots (§v1 3.7) are retained as the profile-integrity mechanism and inherit a rule v1
missed: **a snapshot is a plaintext copy of live cookies**, so it lives with the identity
volume, never under `agentboxHome()` (which the host backup copies recursively), with
retention, space limits and crash-safe deletion tested.

## 8. Acceptance conditions

Carried from v1 where they survived, restated where the review broke them:

1. Capture: the sink policy holds for **every** source in the inventory, and the
   prohibition test fails on a new raw primitive. (v1's "one flag" version is void.)
2. Input: entering login mode refuses every non-owner input path and drains in-flight
   actions; tested with a batch in flight.
3. Profile protection is snapshot-based; a lease start without one is an error.
4. No trusted fill event: Stage A contains no credential filling; the injector re-passes
   review.
5. Fencing: revoke during a slow multi-action batch refuses the remainder **at the box**.
6. Reachability is tested *from the team container* against container addresses, Docker DNS
   names, host-gateway aliases and published ports — not asserted from a topology claim.
7. Targeted delivery: a lease approval reaches the owner when someone else asked.
8. Archives: an **upgraded, previously used** volume carries no identity content.
9. Restart: a lease's fate after a host crash is recorded and auditable; login state
   recovers closed.

## 9. What v1 claimed, and what replaced it

| v1 | Verdict | v2 |
| --- | --- | --- |
| One `login_private` flag at boxd's capture choke point | Refuted — no such choke point | Source/sink model, per-source gate, prohibition test (§5) |
| `MODEL_CALLS`-style enumeration makes it mechanical | Refuted — capture is not syntactically uniform | Centralise, then prohibit raw primitives incl. shell (§5) |
| Host router refuses in-flight calls by epoch | Fatal — effects happen in the box | Execution-local fence between actions (§4, §7.5) |
| "No network path" from team box | Fatal — measured false on this engine | Daemon auth as the boundary; network as a layer (§2, §4) |
| Removing boxd routes removes the escape hatches | Fatal — dock Terminal, `file:`, devtools | Positive image manifest + browser policy (§7.1) |
| Stage A cheats nowhere Stage B must un-cheat | Fatal — taskId, owner approval, export | Absorbed into Stage A (§6) |
| "The owner" presses login | Fatal — reachability is not ownership | Signed principal session on both paths (§7.4) |
| `login_private` makes takeover safe | Fatal — input still flows | Input fencing and drain (§5) |
| `usage.principal` already attributes leased spend | Refuted for asides | Fixed 2026-08-28; billing rule still open (§10) |

## 10. Open questions for this review

1. **Egress: proxy or CDP gate?** The identity box runs only a browser, arguing for the
   lighter gate — but computer-use can type a URL, and `file:`/`data:` are not network
   requests at all. What does the gate miss that a proxy catches, and is the absence of
   non-browser processes load-bearing enough to rely on?
2. **Who pays for leased work** — requester, owner, or a shared budget? These are different
   principals exactly in the case this design exists for, and the aside fix did not decide
   it.
3. **Multiple identities per principal** (work and personal accounts on one site): one box
   with profiles per identity, or one box per identity? Leases name origins; must they name
   profiles?
4. **Second image lifecycle.** One build context, one repository, one tag chain, and one
   global `BOXD_PROTOCOL` today. A narrowed service set needs a capability manifest;
   protocol equality with a full box is not compatibility.
5. **Is §5 closable at all?** The honest possibility is that the inventory cannot be held
   closed across two languages and detached child processes, in which case takeover login
   is unsafe as designed and the alternative — the person logs in on *their own machine*
   and only a session is transferred — should be costed before this is built.
