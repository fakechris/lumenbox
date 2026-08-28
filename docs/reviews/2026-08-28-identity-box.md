# Adversarial review: the identity box (2026-08-28)

Hostile review of [docs/18](../18-identity-box.md), run under the practice in
[docs/13](../13-design-review.md): the job is to find the concrete sequence that makes
the design violate its own security claims, not to approve the direction.

Verdict: nine fatal findings, four major findings, and three refuted claims about the
current code. The container-isolation direction survives. The privacy proof, fencing,
owner authentication, Stage A boundary, and lifecycle design do not.

---

## 1. THE CLAIMED CAPTURE CHOKE POINT DOES NOT EXIST — fatal

SEQUENCE:

1. An agent starts a multi-action computer request against the identity display.
2. The owner presses Login and `login_private` becomes true while that request is running.
3. The already-running executor finishes its remaining clicks and keystrokes, then takes
   the unconditional end-of-batch screenshot.
4. At the same time, x11vnc continues reading the framebuffer so the owner can see the
   login screen. Its separate view-only process can also continue reading it.
5. A browser snapshot does not take a screenshot at all: it executes JavaScript in each
   frame and serializes DOM text and input values. A check written for screenshot methods
   misses it.
6. A clipboard *write* internally reads the selection back to confirm ownership. A check
   only on the `/clipboard/read` route misses that read.

DESIGN SAYS:

One flag in boxd sits at “the single choke point every capture path already flows through,”
and every capture path refuses while it is set (`docs/18-identity-box.md:135-154`).

ACTUALLY HAPPENS:

There is no such choke point. `main.ts` dispatches computer, browser, clipboard, and
recording through separate routes (`src/boxd/main.ts:338-441`). The computer handler calls
an `X11Executor`, and its error path performs another capture independently
(`src/boxd/main.ts:187-229`). `DisplayManager` merely constructs that executor after a
shell script brings up the display stack (`src/boxd/displays.ts:440-478`). Inside the
executor, every action batch returns a screenshot even if no screenshot action was asked
for (`src/cua/x11-executor.ts:357-416`), and the primitive is a direct ffmpeg `x11grab`
(`src/cua/x11-executor.ts:843-865`).

The VNC capture path is outside those TypeScript services. `start-display` launches two
separate x11vnc processes against the same framebuffer and two websockify processes
(`docker/box/start-display:262-306`). The diagnostic script is another direct ffmpeg
capture site (`docker/box/box-doctor:105-121`). A recorder is yet another child ffmpeg
using `x11grab` (`src/boxd/record-service.ts:80-126,149-180`), and a recorder can outlive
the boxd process that started it (`src/boxd/record-service.ts:216-276`).

The document also misclassifies semantic browser capture as “snapshot screenshots.” A
snapshot uses `Runtime.evaluate` (`src/boxd/browser-service.ts:359-390`), and the snapshot
script emits text-field values except fields recognized as password fields
(`src/boxd/browser-snapshot.ts:146-181`). `browser_read` is a separate
`Runtime.evaluate` path (`src/boxd/browser-service.ts:677-688`). Clipboard selection reads
call `xclip -o`, including the read performed from the write-confirmation loop
(`src/boxd/clipboard-service.ts:36-51,104-116`).

There is also an unresolved contradiction: the owner cannot perform takeover login unless
one pixel sink — the owner's VNC connection — remains live. “Every capture path refuses”
is therefore the wrong property. The property must distinguish source, audience, and
sink: owner-private pixels may flow to the authenticated owner; agent/model, recording,
view-only, audit, and recovery sinks must not receive them.

VERDICT:

must-be-replaced. `login_private` cannot be a flag sprinkled on the current service
handlers. Define an identity-display observation capability with explicit sinks and put
the check at the last execution point before each source produces bytes. The owner VNC
exception must be a named, authenticated exception, not an omitted capture path.

## 2. THE MODEL_CALLS-STYLE ENUMERATION PROMISE IS NOT MECHANICAL — fatal

SEQUENCE:

1. A test scans boxd TypeScript for calls named `takeScreenshot` and records their
   enclosing declarations.
2. A later change adds a view-only VNC process in `start-display`, a direct `xwd`, a CDP
   `Runtime.evaluate`, or an internal clipboard read.
3. The new observation path is not shaped like the expression the test scans for, or is
   not TypeScript at all.
4. The test stays green while `login_private` leaks owner activity.

DESIGN SAYS:

The test can enumerate every boxd capture call site using “the same technique” as the
usage ledger's `MODEL_CALLS` guard and thereby make fail-closed mechanical
(`docs/18-identity-box.md:150-154`).

ACTUALLY HAPPENS:

`MODEL_CALLS` works because it searches four named TypeScript files for one syntactically
uniform SDK expression, `messages.create(` or `messages.stream(`, then compares the
enclosing declarations with a fixed allowlist (`src/host/usage.test.ts:173-230`). Capture
has neither property.

For this design, a capture site must mean any source that converts identity state into
bytes available outside the owner's private control channel. The current set includes:

- framebuffer images and window images in `X11Executor`
  (`src/cua/x11-executor.ts:375-406,809-830,843-865`);
- continuous framebuffer readers in `start-display`
  (`docker/box/start-display:262-306`);
- recording and diagnostic ffmpeg processes
  (`src/boxd/record-service.ts:80-126`; `docker/box/box-doctor:105-121`);
- DOM and prose extraction through CDP
  (`src/boxd/browser-service.ts:359-390,677-688`);
- explicit and internal clipboard reads
  (`src/boxd/clipboard-service.ts:36-51,104-116`).

Those are different APIs in TypeScript and shell, some are long-running child processes,
and some are allowed only for one sink. A regex over enclosing declarations cannot prove
that each one consulted a process-local flag at the relevant time.

VERDICT:

must-be-replaced before the acceptance test can exist. First centralize observation behind
a small capability API and statically prohibit raw primitives outside an explicit
allowlist: `x11grab`, `xwd`, `x11vnc`, `xclip -o`, and the relevant CDP evaluation calls.
Then test both the inventory and the sink policy. The current proposed test can be written
as a source-code heuristic; it cannot be written as the claimed fail-closed proof.

## 3. A ROUTER-SIDE EPOCH CHECK CANNOT REFUSE AN IN-FLIGHT EFFECT — fatal

SEQUENCE:

1. Lease epoch 7 is live. The host policy/router checks it and sends one computer request
   containing five actions.
2. Identity boxd admits the request and executes actions one and two.
3. The owner revokes; the host changes its table to epoch 8 and reports “revoked.”
4. Boxd, which has neither the lease nor an epoch check, executes actions three through
   five and takes the final screenshot.
5. The router may discard the response, but the forbidden effects already happened.

DESIGN SAYS:

Revocation increments the host lease table first, after which “any in-flight or queued
call bearing the old epoch is refused by the router”; acceptance requires revoking a slow
call mid-flight and observing a refusal (`docs/18-identity-box.md:99-107,265-266`).

ACTUALLY HAPPENS:

The current tool dispatcher checks policy once before entering its switch, then calls
`box.computer` or `box.browser` (`src/host/tools.ts:1320-1368,1986-2011`). `BoxClient.post`
serializes one body into one HTTP request; aborting the fetch only abandons the client
wait, and its own error contract admits that the operation may still be running
(`src/box/client.ts:109-179`). A computer request currently carries actions, display, and
owner — no lease ID or epoch (`src/box/client.ts:203-221`). `BrowserRequest` likewise has
no lease field (`src/protocol/index.ts:507-529`).

On the server, boxd reads the whole body and awaits the handler before replying; request
closure is not a cancellation signal (`src/boxd/main.ts:522-574`). The executor loops
through the entire batch and performs the automatic capture at the end
(`src/cua/x11-executor.ts:364-416`). A check in the host router therefore has an unavoidable
check/use gap.

VERDICT:

must-be-replaced. The host router may perform the first check, but the final fence must
live in the identity box immediately before execution. Every sensitive request needs a
lease ID and epoch; the identity box needs authoritative revocation state; multi-action
computer batches need a check between actions; browser actions need a check immediately
before CDP dispatch. “Revoked” cannot be shown until the identity box has acknowledged the
new epoch and drained or refused older work.

## 4. “NO NETWORK PATH” IS NOT CREATED BY THE CURRENT PROVISIONER — fatal

SEQUENCE:

1. The provisioner creates a team container and an identity container using the current
   `docker run` builder.
2. Both are attached according to the Docker engine's unstated default because the run
   arguments create no isolated network.
3. Boxd binds all container interfaces, and its daemon port is published without a
   loopback address.
4. The team box probes the host-published port or a reachable container address and reaches
   the identity daemon. Its VNC upgrade path does not require the box token.

DESIGN SAYS:

The team box has “no route,” “no address,” and no network path to an identity box; routing
is exclusively a host capability (`docs/18-identity-box.md:68-73,267-268`).

ACTUALLY HAPPENS:

The current container arguments publish boxd, bind only the *web UI* publication to
`127.0.0.1`, and add no `--network` or network-isolation arguments
(`src/box/docker.ts:360-451`). Boxd itself binds `0.0.0.0`
(`src/boxd/main.ts:627-648`). The control-plane provisioner chooses ephemeral host ports
and adds environment/host-gateway arguments, but creates no per-box network or firewall
(`src/control/compose.ts:136-187`). Boxd's VNC WebSocket upgrade is deliberately
unauthenticated and explicitly warns that a routable publication exposes desktops
(`src/boxd/main.ts:585-625`).

HYPOTHESIS: on a normally configured Docker engine, containers attached to the same
default bridge and host-published ports will provide at least one path. An external daemon
configuration could disable inter-container communication, but no repository code creates
or verifies that property. The design therefore rests on an environmental hope, not on the
provisioner it proposes to extend.

VERDICT:

must-be-replaced with an explicit topology: identity boxes on a host-only/per-container
network, boxd published to a host-only endpoint, deny rules for team-container, Docker
gateway, and sibling-container paths, and a separately controlled browser egress path.
The acceptance test must run from the team container against container addresses, Docker
DNS names, host-gateway aliases, and published host ports.

## 5. REMOVING BOXD ROUTES DOES NOT REMOVE THE BROWSER'S ESCAPE HATCHES — fatal

SEQUENCE:

1. Stage A derives its identity image from the existing desktop image and removes the
   shell/fs/job HTTP services.
2. The leased agent still has computer input and clicks the Terminal or Files launcher on
   the identity desktop.
3. The `box` user receives a Bash shell with passwordless sudo and reads or copies the
   persistent browser profile directly.
4. Alternatively, browser navigation opens `file:`/`data:` content or a download that the
   desktop can open, bypassing the origin model applied only to network requests.

DESIGN SAYS:

The identity image lacks the dangerous services at build time; “an absent binary cannot”
be talked into exposing the profile (`docs/18-identity-box.md:75-88`).

ACTUALLY HAPPENS:

That statement names absent *services*, not absent capabilities. The current image installs
shell tools, Python, sudo, X11 utilities, and ffmpeg (`docker/box/Dockerfile:15-33`). Its
`box` user has `/bin/bash` and passwordless sudo (`docker/box/Dockerfile:46-67`). It also
installs terminal and file-manager applications (`docker/box/Dockerfile:142-152`), creates
executable Terminal and Files launchers, and places both on the dock
(`docker/box/Dockerfile:162-200`; `docker/box/start-display:211-221,239-260`). Computer
input is therefore already a shell surface in this image even when boxd has no `/exec`.

The browser is another local capability surface. The host deliberately accepts `file:` and
`data:` for box-local browser navigation (`src/host/web.ts:244-271`), and boxd passes a URL
straight to CDP `Page.navigate` (`src/boxd/browser-service.ts:623-629`). The wrapper enables
remote debugging, uses `--remote-allow-origins=*`, runs `--no-sandbox`, and does not disable
extensions (`docker/box/box-chrome:41-80`). Download events merely report that a file is in
the browser's download directory (`src/boxd/browser-service.ts:226-232`).

HYPOTHESIS: whether a particular download, extension, external protocol handler, DevTools
page, or desktop association yields code execution depends on the final Chromium policy
and identity image. The document specifies none of those policies. The terminal-launcher
path is not hypothetical if the existing image is the base.

VERDICT:

must-be-replaced with a positive image manifest, not a route subtraction. Remove terminal
and file managers, Bash/sudo/package tools/interpreters not required at runtime, desktop
execution launchers, and raw profile-readable helpers. Define Chrome enterprise policy for
extensions, DevTools, downloads, external protocols, and dangerous schemes. Origin
enforcement must cover semantic browser calls, typed navigation through computer use, and
non-network schemes.

## 6. STAGE A REQUIRES THE MACHINERY IT DEFERS TO STAGE B — fatal

SEQUENCE:

1. A Stage A lease says it is scoped to `taskId=t7` and `https://bank.example`.
2. The channel receives `taskId=t7`, but the turn and `ToolContext` never receive it.
3. The router can identify the caller and agent, but not the task whose lease it must
   select or revoke.
4. Stage A deliberately has no origin enforcement, so any action routed to the logged-in
   browser can navigate outside the approved origin.
5. The browser downloads a statement. The proposed identity box has no fs service, while
   the only current host-mediated exact-byte download API is `/fs/download`.
6. Approval still goes to the last asker because a pending approval has no identity owner
   or lease/task fields.

DESIGN SAYS:

Stage A is single-user but “cheats nowhere that Stage B would have to un-cheat”
(`docs/18-identity-box.md:37-38`). It includes task/origin leases, owner-targeted approval,
and task-scoped file egress, while origin enforcement and real owner/requester separation
wait for Stage B (`docs/18-identity-box.md:227-245`).

ACTUALLY HAPPENS:

The channel `ask` callback receives a task ID, records it on delivery debt, and may use it
to retitle the board row, but calls `orchestrator.prompt` without it
(`src/web/server.ts:637-685,692-740`). `Orchestrator.prompt` has caller and conversation
options but no task ID (`src/host/orchestrator.ts:712-731`). `ToolContext` has caller,
display, owner token, and box client, but no task identity (`src/host/tools.ts:40-101`).
The browser protocol also carries no task, lease, or epoch (`src/protocol/index.ts:507-529`).

The task store does have a persisted requester and additive update listeners that could
observe closure (`src/host/tasks.ts:57-70,81-96,263-268`), but that fact does not connect a
tool call to the task. Targeted approval is also not a small delivery substitution:
`PendingApproval` has only fingerprint, agent, description, and time
(`src/host/policy.ts:63-79,461-468`), while the live callback sends it to
`notifyApproval`, which uses `lastAsker` (`src/web/server.ts:1257-1266`;
`src/channels/manager.ts:733-760`).

File egress is internally contradictory. The document removes fs-service but requires the
host to copy named downloads. The existing exact-byte client method calls `/fs/download`
(`src/box/client.ts:341-353`), and that endpoint is part of the fs service routes the
identity image says it omits (`src/boxd/main.ts:460-470`). A new narrow, fixed-directory,
read-once export service is Stage A machinery, not an implementation detail.

Finally, acceptance condition 6 requires two principals even though Stage B is where
multiple principals and owner/requester separation are first exercised
(`docs/18-identity-box.md:243-245,269-270`). The stage cannot satisfy its own acceptance
suite.

VERDICT:

must-be-replaced. A shippable Stage A must include task identity propagation, owner-bound
approval records and delivery, the two-principal test fixture, execution-local origin
enforcement, and a narrow export capability. Otherwise call it an insecure prototype and
do not migrate real browser sessions into it.

## 7. “THE OWNER” IS NOT AUTHENTICATED AT THE LOGIN BUTTON OR VNC SOCKET — fatal

SEQUENCE:

1. The web server runs in direct mode with no asserted principal. It either has no token
   on loopback or uses the one installation-wide UI token.
2. Any client that reaches the port or holds that token opens Alice's identity-box login
   route.
3. `callerOf` treats an unauthenticated direct caller or an authenticated caller with no
   user header as owner; the role gate treats no `userId` as admin.
4. The client starts `login_private`, opens the driving VNC stream, and watches or drives
   Alice's login session without proving it is Alice.

DESIGN SAYS:

Only “the owner” enters and leaves takeover login from the web UI
(`docs/18-identity-box.md:161-162,201-206`).

ACTUALLY HAPPENS:

With no UI token, loopback reachability is authentication
(`src/web/auth.ts:128-136,170-176`), and the server logs that anything reaching the port
can drive agents (`src/web/server.ts:3211-3231`). `callerOf` assigns the owner role when no
identity is asserted (`src/web/auth.ts:64-85`), and the API role gate upgrades absent
`userId` to admin (`src/web/server.ts:1763-1802`). The repository's stated direct-mode
model is one shared secret and no users: any holder can drive every agent
(`README.md:203-217`). That authenticates an installation operator, not the principal who
owns a particular identity box.

The existing WebSocket path is weaker than the HTTP identity path. HTTP requests merge a
signed web-session identity into `caller` (`src/web/server.ts:1724-1738`), but the VNC
upgrade chooses driving versus view-only from `callerOf(req.headers, ...)` directly and
does not read the web-session identity (`src/web/server.ts:3148-3175`). A browser using the
web-session path does not add the gateway identity headers, so this path falls back to the
direct owner role.

VERDICT:

must-be-replaced. Identity login must require a signed principal session (or trusted
gateway identity) whose resolved principal equals the identity-box owner, with the same
check on the HTTP page and the RFB upgrade. Direct no-user/token-holder mode must not open
identity profiles. Add CSRF/re-authentication appropriate to starting a credential-bearing
session; reachability is not ownership.

## 8. `login_private` STOPS OBSERVATION, NOT AGENT INPUT — fatal

SEQUENCE:

1. A leased agent has an admitted computer batch executing against the identity display.
2. The owner starts takeover login. The red state blocks later screenshots but does not
   revoke or drain the input batch.
3. The owner clicks a password field through VNC.
4. The agent's remaining key or click lands in the same display, submits the form, changes
   focus, or pastes text while the owner is typing.
5. Nobody gets a screenshot, so the most dangerous interference is also the least visible.

DESIGN SAYS:

Takeover login changes the capture state; the agent never sees the password, and the owner
is allowed to drive the identity display (`docs/18-identity-box.md:30-35,135-162`). The
document asks who may drive only as an open question (`docs/18-identity-box.md:289-291`).

ACTUALLY HAPPENS:

Current x11vnc is started `-shared`, allowing concurrent driving connections
(`docker/box/start-display:271-286`). The host display lease excludes only a second agent;
it has no owner-login state (`src/box/display-lease.ts:20-53`). The computer tool acquires
that agent lease and then awaits the whole box request (`src/host/tools.ts:1340-1368`). The
executor has no cancellation check between actions (`src/cua/x11-executor.ts:364-406`).
Separately, user messages may steer an active turn at the next model-round boundary
(`src/agents/bus.ts:396-419`; `src/host/turn.ts:1220-1244`), which is not a mechanism for
stopping already-dispatched display input.

VERDICT:

must-be-replaced with an exclusive owner-login mode. Entering it must first revoke identity
leases, fence new input, wait for or abort acknowledged in-flight actions at the identity
box, and only then expose the login UI. While active, every non-owner input path —
computer, browser action, clipboard write, and other VNC drivers — must be refused. Capture
privacy alone does not make takeover safe.

## 9. THE SECOND DISPLAY HAS NO ADDRESSING OR GATING DESIGN IN THE WEB PROXY — major

SEQUENCE:

1. Alice and Bob each have an identity box, and each box uses display 1.
2. Alice opens the current stable URL `/desktop/1/`.
3. The host proxy has only one provisioner endpoint and resolves no principal or box ID
   from that path.
4. An ad-hoc “currently selected box” implementation can race and route Alice to the team
   box or Bob's display; a direct connection to the published identity box can bypass host
   principal checks entirely.

DESIGN SAYS:

The owner gets a noVNC view of “the identity display,” but does not define its host route,
box selector, or authorization boundary (`docs/18-identity-box.md:201-206`).

ACTUALLY HAPPENS:

The current web path identifies only a display index, and maps it to `/vnc/<index>` or
`/vnc-ro/<index>` (`src/web/server.ts:3258-3278`). Both HTTP and WebSocket proxying resolve
one `provisioner.endpoint()` into one cached origin (`src/web/server.ts:1376-1422,3178-3201`).
There is no identity-box ID in the URL or resolver. Boxd's RFB upgrade performs no token
authentication of its own (`src/boxd/main.ts:585-625`), while the current Docker builder
publishes that boxd port (`src/box/docker.ts:376-386`).

VERDICT:

must-be-redesigned. The route must bind `{principal, identityBoxId, display}` to the
authenticated owner on every asset request and WebSocket upgrade; the host must resolve
that exact container; and the boxd endpoint must not be directly routable from browsers,
team boxes, or other tenants. Display index alone is not an identity.

## 10. `usage.principal` DOES NOT ALREADY ATTRIBUTE ALL LEASED SPEND — major

SEQUENCE:

1. A requesting principal starts leased work.
2. The main model round records the caller principal.
3. The same turn performs summarization, memory extraction, or selection calls through
   `recordAside`.
4. Those usage rows have no principal field, so per-principal totals place part of the work
   in the empty group.
5. Nothing on any row says which identity lease or owner caused the cost.

DESIGN SAYS:

“Spend attribution needs nothing new” because leased work already bills the requesting
principal through `usage.principal` (`docs/18-identity-box.md:191-197`).

ACTUALLY HAPPENS:

The narrow factual core is real: `UsageRecord.principal` exists, is optional, and
per-principal aggregation uses it (`src/host/usage.ts:80-87,246-257,276-294`). Direct turn
rows copy `deps.caller.userId` into it (`src/host/turn.ts:1485-1507`).

The conclusion is false. `recordAside` has no principal option and emits none
(`src/host/usage.ts:316-348`). The turn meter calls that API without a principal
(`src/host/turn.ts:853-866`), as do memory and selection calls
(`src/host/remember.ts:163-179`; `src/host/orchestrator.ts:650-665`). Caller state is also a
per-agent cache: a prompt sets it only when a user ID is present, and a later turn reads
the cached value (`src/host/orchestrator.ts:712-729,481-513`).

HYPOTHESIS: a later wake or scheduled turn for that agent can inherit the most recently
cached human principal rather than becoming unattributed. The two cited call sites show no
clearing operation, but this review did not execute that interleaving.

VERDICT:

must-be-redesigned. Propagate an explicit billing principal on every model call and record
the lease/task execution identity on all usage rows. Decide explicitly whether the payer
is requester, identity owner, or a shared budget; those are different principals exactly
in the Stage B case the design cares about.

## 11. HOST RESTART HAS NO LEASE OR PRIVACY RECOVERY PROTOCOL — fatal

SEQUENCE — HYPOTHESIS, because no lease implementation exists:

1. Epoch 11 is live and a browser/computer request is executing inside the identity box.
2. The host crashes. The container remains running under Docker's restart policy and the
   effect may continue after the client disappears.
3. The host restarts with no specified durable lease table, epoch floor, or reconciliation
   handshake.
4. If it recreates epoch 11 or treats a missing row as free, stale work can be admitted. If
   it treats every missing row as revoked, live leases disappear without an auditable
   revocation or task transition.
5. A boxd restart during owner login similarly has no specified persisted
   `login_private` state, so the red state can clear while the owner is still on the login
   screen.

DESIGN SAYS:

The host owns the lease table and revocation makes old work stop, but it defines no
persisted record, restart ordering, reconciliation, or terminal recovery state
(`docs/18-identity-box.md:90-107,225-245`).

ACTUALLY HAPPENS:

Current box containers use `--restart unless-stopped` (`src/box/docker.ts:394-398`). The
current client explicitly treats timeout as an unknown effect because the operation may
still be running in the box (`src/box/client.ts:38-48,162-168`). Current display ownership
had to be persisted separately precisely because X servers and applications survive a
boxd restart (`src/boxd/displays.ts:79-89`). The proposed lease and privacy flags have no
equivalent recovery design.

VERDICT:

must-be-replaced with a durable, monotonic authority protocol. On host boot, fence all
pre-crash epochs before accepting work; reconcile each identity box; choose and record
restore-versus-revoke for every lease; re-arm expiry; settle task closures that occurred
during downtime; and recover owner-login state fail-closed. A host in uncertain state must
not route identity actions.

## 12. THE SECOND IMAGE HAS NO BUILD, COMPATIBILITY, UPGRADE, OR ROLLBACK CONTRACT — major

SEQUENCE:

1. The host/router is upgraded to send epoch-bearing identity requests.
2. The team image is rebuilt, but the identity image remains on an older narrowed boxd.
3. Both announce the same boxd protocol number or only the team box is checked.
4. The host routes a leased call; the old identity box ignores a new optional fence field
   or lacks the required route, so failure appears mid-task.
5. Rolling back `agentbox/box:latest` does not identify which identity image/profile
   migration must roll back with it.

DESIGN SAYS:

Stage A adds a second, differently composed image but says nothing about how it is built,
tagged, checked, upgraded, or rolled back (`docs/18-identity-box.md:75-88,227-240`).

ACTUALLY HAPPENS:

The build script has one context (`docker/box`), one repository (`agentbox/box`), and one
latest/previous tag chain (`scripts/build-image.mjs:25-26,57-70`). Package scripts bundle
one `src/boxd/main.ts` into one `docker/box/boxd.cjs` and build that one image
(`package.json:10-16`). `BoxManager` has one default image and compares one running image
with one built tag (`src/box/docker.ts:53-54,684-700`).

The current compatibility handshake is one global `BOXD_PROTOCOL` number
(`src/protocol/index.ts:388-398`), and `BoxClient` assumes equal protocol means the host can
drive the box (`src/box/client.ts:72-95`). A narrowed service set needs either a capability
manifest or a distinct protocol contract; equality with a full box is not enough.

VERDICT:

must-be-redesigned before Stage A is estimable. Define the identity build context and
artifact, content-addressed tags, service manifest/protocol, host/team/identity compatibility
matrix, upgrade order, health check, profile migration version, and independent rollback.
The upgrade must not report success until both box kinds speak the expected contract.

## 13. THE ARCHIVE FIX CREATES ANOTHER PLAINTEXT SESSION ARCHIVE AND MISSES LEGACY STATE — major

SEQUENCE:

1. A used team box already has logged-in profiles under `.config/box-chrome-*`.
2. Stage A changes future Chromium profiles to another location but does not erase or
   quarantine the old directories.
3. The next team-volume upgrade archive still contains the old cookies even though the
   new browser starts logged out.
4. On the identity side, Stage A tars the live profile at every lease start and retains it
   for N days, creating a new plaintext copy of the very sessions excluded from “every
   plain archive.”

DESIGN SAYS:

The migration makes the team box login-free, excludes identity volumes from every plain
archive, and uses a tar snapshot of the profile in Stage A
(`docs/18-identity-box.md:164-189,238-241`).

ACTUALLY HAPPENS:

The current profile path is inside the persistent config volume
(`docker/box/box-chrome:12-38`), and the volume exists specifically so browser profiles and
logins survive image changes (`docker/box/entrypoint.sh:59-70`;
`src/box/docker.ts:421-433`). The current archive iterates both work and config volumes and
tars their contents (`src/box/docker.ts:637-672`); the upgrade command invokes it before
recreate (`src/cli.ts:97-125`). Its only exclusion is `./.spool`
(`src/box/docker.ts:22-32`), and the test only pins that exclusion
(`src/box/docker.test.ts:23-59`).

The “fresh archive” acceptance test is insufficient: a fresh empty volume proves nothing
about an upgraded, previously used volume. Separately, the proposed profile snapshot is
itself a plaintext archive of live cookies. The document gives no storage location,
permissions, access path, deletion ordering, inclusion/exclusion from host backup, or
crash cleanup for those tar files. That location is load-bearing: the separate host backup
recursively copies all of `agentboxHome()` (`src/host/backup.ts:85-110`), so placing profile
snapshots under host state would silently put them into another backup surface.

VERDICT:

must-be-redesigned. Test migration from a fixture containing known legacy cookie stores,
verify their removal from the live team volume and every later archive, and issue a
receipt. Treat profile snapshots as identity secrets: isolate them with the identity
volume, encrypt them or explicitly accept the plaintext risk, enforce retention and space
limits, and test crash-safe deletion. “Not in upgrade.tar.gz” is not the whole archive
boundary.

## CODEBASE CLAIM AUDIT

1. **REFUTED — “boxd capture paths already flow through one service-layer choke point.”**
   The routes are separate (`src/boxd/main.ts:338-441`), the X11 executor captures
   unconditionally (`src/cua/x11-executor.ts:357-416`), x11vnc and websockify are separate
   processes (`docker/box/start-display:262-306`), browser snapshots are CDP DOM extraction
   (`src/boxd/browser-service.ts:359-390`), and clipboard writes contain a read
   (`src/boxd/clipboard-service.ts:104-116`). This false premise is fatal.

2. **CONFIRMED — “the `.config` volume persists browser logins by design.”** The archive
   warning states that purpose explicitly (`src/box/docker.ts:35-51`), the Docker builder
   mounts `.config` as a named volume (`src/box/docker.ts:421-433`), and Chromium stores
   each display profile beneath it (`docker/box/box-chrome:12-38`).

3. **CONFIRMED — “the upgrade archive includes browser sessions.”** `backupVolumes`
   archives the entire config volume (`src/box/docker.ts:620-672`), and `box up --recreate`
   calls it before replacement (`src/cli.ts:97-125`). The source itself says the config
   volume holds logged-in browser sessions (`src/box/docker.ts:620-626`).

4. **CONFIRMED — “approval delivery currently routes to `lastAsker`.”** `remember` records
   agent-to-last-channel identity (`src/channels/manager.ts:569-581,671-675`), and
   `notifyApproval` sends to that map entry (`src/channels/manager.ts:733-760`). The test
   explicitly asserts “whoever last drove” (`src/channels/manager.test.ts:393-409`).

5. **REFUTED AS STATED — “`usage.principal` already attributes leased spend, so nothing
   new is needed.”** The field and direct-turn write are CONFIRMED
   (`src/host/usage.ts:80-87`; `src/host/turn.ts:1485-1507`), but non-turn model calls use
   `recordAside`, which cannot carry a principal (`src/host/usage.ts:316-348`). Current
   browser requests carry no lease identity (`src/protocol/index.ts:507-529`). The
   no-new-work conclusion is false.

## OVERALL VERDICT

### What survives

- Keep the product boundary: login state belongs in a principal-owned container, not in
  the team workstation, and no profile or workspace volume is shared.
- Keep human-entered takeover login and keep credential injection out of Stage A.
- Keep task-scoped, host-mediated named-file transfer, but implement it as a narrow export
  capability rather than retaining general fs-service.
- Keep origin restriction below the model, profile rollback before leased work, explicit
  logout/deletion, and a visible private-login state as goals.
- Keep the migration admission that today's team config and upgrade archives contain
  sessions. That factual starting point is correct.

### What must be redesigned

- §3.1: explicit Docker topology and host-only routing, including the VNC endpoint.
- §3.2: a positive identity-image capability manifest and browser hardening, not a list of
  omitted boxd routes.
- §3.3: owner-bound approval plus an execution-local, durable epoch fence.
- §3.4: origin enforcement in Stage A across semantic calls, computer-driven navigation,
  downloads, local schemes, and browser escape surfaces.
- §3.6: a source/sink privacy model, exclusive owner-login mode, and a real enumeration
  mechanism.
- §§3.7-3.8: snapshot secrecy, legacy-profile migration, archive coverage, retention, and
  crash-safe deletion.
- §3.9: complete usage propagation and an explicit requester-versus-owner billing rule.
- §4.1: principal authentication and second-box noVNC addressing on both HTTP and
  WebSocket paths.
- §5 and §6: Stage A must absorb the security machinery currently deferred to Stage B;
  its tests must exercise upgraded state, two principals, revocation during execution,
  direct network probes, and concurrent owner/agent input.

Overall: **reject as a build plan**. The isolation direction is worth keeping, but the
document currently promises security properties that the proposed enforcement points
cannot implement. Building Stage A as written would concentrate valuable sessions in a
new container while leaving the decisive observation, input, routing, authentication,
restart, and browser escape paths outside the claimed controls.

### The three most important questions the document failed to ask

1. **What execution-local authority, inside the identity box, refuses the next effect after
   revoke or takeover-login begins — including the remainder of an already admitted
   multi-action request?**
2. **What exactly counts as an observation, which authenticated sink may receive it, and
   how is the complete source/sink graph mechanically closed across TypeScript, shell,
   child processes, CDP, clipboard, recordings, and VNC?**
3. **What durable record joins owner, requester, task, lease, epoch, approval, usage, file
   egress, and login-private state across host and box restarts, and which component is
   authoritative during recovery?**
