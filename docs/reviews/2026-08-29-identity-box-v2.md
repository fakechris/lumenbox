# Second adversarial review: the identity box v2 (2026-08-29)

Method: read the first rejection before v2, then trace each claimed replacement through
the current TypeScript, shell and prior-art implementations. The review question is not
whether v2 names the right failure; it is whether the named replacement creates an
authoritative refusal that can be built and tested.

Verdict: eleven fatal findings and one major finding. None of the nine v1 fatals is
closed. Section 9 relabels eight and silently substitutes v1's usage-attribution major
for the missing restart fatal.

---

## 1. THE CAPTURE INVENTORY IS ALREADY PROVABLY OPEN — fatal

SEQUENCE:

1. Implement the §5 guard exactly as written: allowlist the named raw primitives
   `x11grab`, `xwd`, `x11vnc`, `xclip -o`, and CDP evaluation across TypeScript and shell.
2. Run the existing `vnc-probe` unchanged. It opens an RFB socket, negotiates raw
   encoding, requests the complete framebuffer, and reads each rectangle's pixel bytes.
3. The guard passes because `vnc-probe` is Python and contains none of §5's prohibited
   capture invocations.
4. During `login_private`, the probe receives owner-private pixels anyway.

DESIGN SAYS:

The inventory becomes mechanical by centralising capture and prohibiting named raw
primitives outside an allowlist across TypeScript and shell; a new path must declare a
sink before it passes (`docs/18-identity-box.md:169-174`). Section 10.5 asks whether that
inventory is closable at all (`docs/18-identity-box.md:283-286`).

ACTUALLY HAPPENS:

The existing tree contains a capture implementation that the inventory in §5 does not
name. `vnc-probe` explicitly says it asks for the whole framebuffer
(`docker/box/vnc-probe:11-14`), requests raw RFB encoding (`docker/box/vnc-probe:81-87`),
and reads `w * h * 4` bytes for each raw rectangle (`docker/box/vnc-probe:90-118`). Its
main path connects to the local RFB service, requests a full update, and consumes it
before the freshness loop (`docker/box/vnc-probe:132-163`).

This is not just one missing string to add. Xvfb is launched with X access control
disabled (`docker/box/start-display:110-114`), and its socket directory is mode 1777
(`docker/box/Dockerfile:63-67`). Any runtime process capable of speaking X11 or RFB can
read pixels without spelling one of the five strings. The proposed guard enumerates
spellings, not authorities. It cannot prove that a new library client, copied binary, or
protocol implementation declared a sink.

VERDICT:

**No: the capture inventory is not closable under v2's mechanism.** It is refuted by an
existing, in-repository reader before implementation begins. It becomes closable only
if one component has exclusive access to the X framebuffer and every observation is a
typed, audience-bound request through that component. That is an architecture replacement,
not the proposed allowlist.

The own-machine alternative is better on exactly one dimension: credentials are entered
where neither this X server nor its input/capture processes exist. It is not demonstrated
better end to end. V2 supplies no session-transfer format, authentication, encryption,
recipient binding, browser/profile compatibility, expiry, rotation, revocation, or audit
contract; it only names the alternative (`docs/18-identity-box.md:283-286`). Therefore
takeover is unsafe as designed, while session transfer is an undesigned alternative—not
a Stage A fallback that can be approved.

## 2. “CENTRALISE” DOES NOT CONTROL THE PROCESSES THAT OUTLIVE BOXD — fatal

SEQUENCE:

1. Recording is active and both VNC stacks are serving a desktop.
2. boxd crashes. The recording ffmpeg and display processes survive.
3. The replacement daemon restores `login_private` fail-closed, but it has not yet killed
   the old recorder; the VNC processes continue polling X throughout.
4. Alternatively, an implementation kills a non-owner x11vnc process on entry to private
   mode. The display supervisor reruns `start-display`, which sees the port missing and
   starts it again.
5. The visible red state says private while pixels continue to reach a recording, a VNC
   sink, or both.

DESIGN SAYS:

Every source will consult a gate at the last point before bytes exist, including
long-running children started by shell (`docs/18-identity-box.md:166-174`), and privacy
state will survive daemon restart fail-closed (`docs/18-identity-box.md:185-186`). The
owner's authenticated display remains a permitted sink while agent, recording,
view-only, audit and diagnostic sinks are denied (`docs/18-identity-box.md:162-165`).

ACTUALLY HAPPENS:

The recorder is not a call that can consult a TypeScript flag per frame. boxd spawns a
standalone `ffmpeg` whose input is `x11grab` (`src/boxd/record-service.ts:80-126`,
`src/boxd/record-service.ts:149-179`). The code documents that it is adopted by PID 1 and
keeps writing after boxd dies (`src/boxd/record-service.ts:216-226`). The replacement
daemon only scans and SIGTERMs such orphans after the HTTP server has begun listening
(`src/boxd/main.ts:660-673`).

The live and view-only paths are four other detached processes. `start-display` launches
two `x11vnc` instances with `-forever -shared -nopw` and two websockify instances
(`docker/box/start-display:262-306`). It deliberately uses `setsid` for Xvfb so components
outlive the spawning shell (`docker/box/start-display:110-114`), and the same detached
pattern is used for VNC. boxd's supervisor reruns `start-display` every 15 seconds and
passes only a crash-loop skip list (`src/boxd/displays.ts:40`,
`src/boxd/displays.ts:206-251`). The script's skip mechanism knows component names, not
privacy state or audiences (`docker/box/start-display:45-54`).

There is no concrete definition of “centralise” that preserves these raw X consumers and
also makes one last-byte gate authoritative. A recorder cannot remain a direct `x11grab`
client; an x11vnc cannot remain a direct X client; and the owner and view-only streams
cannot remain routes distinguished only by path behind the same host-hop bearer. They
must become clients of an exclusive observation broker, and the broker must bind every
stream to an authenticated sink capability. V2 defines none of that process topology or
protocol.

The input half is equally non-atomic. The driving VNC server is `-shared`, so multiple
drivers are accepted (`docker/box/start-display:273-286`). V2 says entry must fence new
input, drain or abort in-flight input, deny computer/browser/clipboard/other VNC, and only
then show login (`docs/18-identity-box.md:176-183`), but it does not say which component
owns that state, how the supervisor learns it, how existing RFB sockets are classified and
drained, or what acknowledgement makes it safe to open the login UI.

VERDICT:

This replacement is cosmetic. V2 turns “one flag” into “one gate per source” without
designing how detached sources consult it or how an allowed owner stream is separated
from forbidden VNC audiences. The current lifecycle contains a concrete post-crash and
post-repair leak sequence. The capture and input fatals remain.

## 3. “BETWEEN ACTIONS” IS NOT AN EXECUTION-LOCAL EFFECT FENCE — fatal

SEQUENCE:

1. The identity box accepts a lease-bearing computer batch.
2. The first high-level action is a click with modifiers, a drag path, a held key, or a
   long type operation.
3. Revocation commits after that action begins.
4. A proposed check “between actions” cannot run until the entire composite xdotool
   command, hold, or typing chunk finishes.
5. Input effects occur after revocation. The slow multi-action test passes if it checks
   only that later top-level actions were skipped.

DESIGN SAYS:

The identity box will stop the next effect by checking between actions of a batch
(`docs/18-identity-box.md:131-135`), with another check immediately before CDP dispatch,
centaur's acknowledgement barrier and cindy's compare-at-commit
(`docs/18-identity-box.md:220-222`).

ACTUALLY HAPPENS:

No request carries an execution identity to fence. `ComputerRequest` contains actions,
owner, display and a typing option (`src/protocol/index.ts:99-120`); `BrowserRequest`
contains display, owner and operation fields (`src/protocol/index.ts:507-530`). The host
client sends the same fields (`src/box/client.ts:203-221`), and boxd passes only actions
and typing options into the executor (`src/boxd/main.ts:187-200`). There is no lease ID,
epoch, task ID, guard callback, or authoritative box-local lease lookup on this path.

Even after adding one check at the existing loop, “action” is not “effect.” The loop calls
`executeAction` once per top-level action (`src/cua/x11-executor.ts:375-400`). A click puts
modifier down, pointer movement, repeated clicks and modifier release into one xdotool
command (`src/cua/x11-executor.ts:431-448`). A drag similarly bundles movement, mouse-down,
the entire path and mouse-up (`src/cua/x11-executor.ts:459-481`). A held key performs
key-down, sleeps, then performs key-up (`src/cua/x11-executor.ts:560-568`). Typing is sent
in commands of up to 50 characters (`src/cua/x11-executor.ts:111-114`,
`src/cua/x11-executor.ts:705-730`). A revoke between any of those sub-effects cannot be
observed at the proposed boundary.

The browser has the same missing contract. A CDP connection is held across calls
(`src/boxd/cdp.ts:14-17`), and the actual irreversible dispatch is the WebSocket send in
`CdpSession.send` (`src/boxd/cdp.ts:164-178`). High-level calls send input and then make
additional report/snapshot calls (`src/boxd/browser-service.ts:849-899`). V2 does not say
how a request-bound lease reaches `CdpSession.send`, what state that method reads, or how
revoke is linearized against a send already crossing the socket.

VERDICT:

The design is not sufficient to build from. It must specify the box-authoritative lease
record, request fields, monotonic comparison, revoke endpoint, serialization point,
queued-work rule, browser-session binding, and the acknowledgement returned only after
every older effect is impossible. It must also define effect boundaries below the current
top-level actions. Naming two check locations does not close v1 fatal 3 or v1 fatal 8.

## 4. THREADING `taskId` IS A TURN-IDENTITY REDESIGN, NOT A SMALL STAGE A ABSORPTION — fatal

SEQUENCE:

1. Two user messages in the same conversation and lane arrive with different task IDs.
2. The bus drains both into one turn, or a later user message steers the running turn.
3. The turn invokes computer or browser tools.
4. A scalar `taskId` added only to `orchestrator.prompt` or `ToolContext` must choose one
   task and therefore one lease for effects caused by a turn containing both messages.
5. The router selects a lease, but the selection is not causally tied to the message that
   caused the tool call.

DESIGN SAYS:

Stage A “absorbs” task identity because `taskId` currently reaches the channel and stops
there; it says `taskId` must reach the tool layer so the router can select a lease
(`docs/18-identity-box.md:193-195`). It groups owner-bound approval, read-once export,
origin enforcement and a two-principal fixture as the other absorbed items
(`docs/18-identity-box.md:196-205`).

ACTUALLY HAPPENS:

The channel records `taskId` on the delivery and uses it to retitle the board item, but
calls `orchestrator.prompt` without it (`src/web/server.ts:637-685`,
`src/web/server.ts:688-740`). `prompt` has no task argument, stores caller identity in a
per-agent cache, and sends only conversation/steerability/lane to the bus
(`src/host/orchestrator.ts:790-806`). Later `executeTurn` obtains that per-agent caller and
constructs `TurnDeps` (`src/host/orchestrator.ts:535-583`). Neither `TurnDeps` nor
`ToolContext` has task identity (`src/host/turn.ts:273-332`, `src/host/tools.ts:40-141`),
and both the normal and crash-resume dispatch paths construct contexts without it
(`src/host/turn.ts:967-993`, `src/host/turn.ts:1640-1678`).

The required change is larger than adding three optional properties. `InboundMessage`
has no task ID (`src/agents/bus.ts:38-88`), and `sendFromUser` cannot accept one
(`src/agents/bus.ts:343-359`). The bus batches every message in the chosen conversation
and lane into one turn (`src/agents/bus.ts:369-389`), while mid-turn steering consumes
later user messages (`src/agents/bus.ts:396-419`). The same agent can also run different
conversations concurrently (`src/agents/bus.ts:157-164`), making the per-agent caller
cache itself the wrong model for any task-bound authority.

The other “absorptions” are nouns, not contracts. `PendingApproval` stores fingerprint,
agent, description and time, but no requester, owner, task, lease or target identity box
(`src/host/policy.ts:63-79`, `src/host/policy.ts:461-468`); delivery still notifies by
agent (`src/web/server.ts:1257-1266`). The only exact-byte export client calls general
`/fs/download` (`src/box/client.ts:341-353`). V2 does not define an export root, capability
holder, owner/lease/task binding, atomic read-once consumption, retry behavior, delivery
recipient, or deletion rule.

Section 9's substituted usage row has a real but narrower code change. `recordAside` now
accepts and persists `principal` (`src/host/usage.ts:320-352`); the turn summarizer passes
the turn caller (`src/host/turn.ts:853-868`); and memory batches attribute only when every
exchange has the same payer (`src/host/remember.ts:82-109`,
`src/host/remember.ts:232-249`). That closes the exact missing-field defect from v1
finding 10. It does not establish leased-work billing. Selection usage still reads the
per-agent `callers` cache (`src/host/orchestrator.ts:722-741`) while the bus permits the
same agent to run different conversations concurrently (`src/agents/bus.ts:157-164`), so
one conversation can overwrite the principal used by another. V2 itself leaves the
requester-versus-owner billing rule open (`docs/18-identity-box.md:274-276`).

VERDICT:

Stage A still depends on undefined cross-component machinery. It needs a durable causal
identity on every inbound message, an explicit policy for multi-message/steered turns,
and a lease binding propagated through normal and replayed tool dispatch into boxd.
Approval and export each need their own owner-bound state machines. The section-6 list
does not close v1 fatal 6.

## 5. THE SHIPPED DAEMON AUTH FIX DOES NOT ESTABLISH A TEAM-BOX-TO-IDENTITY-BOX BOUNDARY — fatal

SEQUENCE:

1. A team-box agent uses passwordless sudo to inspect the environment of its in-container
   host daemon and obtains the boxd bearer from `AGENTBOX_TOKEN`.
2. **HYPOTHESIS (permitted by v2):** the identity-box provisioner is implemented through
   `defaultBoxConfig`, as the current ordinary provisioner is, and inherits the
   installation-wide token from `AGENTBOX_HOME/token`.
3. The team box connects to the identity box's reachable private address and supplies that
   bearer.
4. boxd accepts every HTTP route and the VNC upgrade. The negative “missing/wrong token”
   probe still passes.

DESIGN SAYS:

The enforcement table places the team-box boundary at daemon authentication on every
route, tested from inside the team container (`docs/18-identity-box.md:131-134`). V2 says
that boundary “already shipped” and an identity box simply inherits it
(`docs/18-identity-box.md:140-145`).

ACTUALLY HAPPENS:

The shipped fix authenticates a bearer on HTTP (`src/boxd/main.ts:522-537`) and before the
WebSocket opens an upstream connection (`src/boxd/main.ts:585-630`). Its own comment is
explicit: this authenticates the host hop, not the human (`src/boxd/main.ts:600-602`). The
test is a source-text ordering test: it checks that `authorized(req)` occurs before
`netConnect` and that the host writes an Authorization header
(`src/boxd/upgrade-auth.test.ts:26-59`). It does not test token uniqueness, source identity,
non-disclosure, task binding, lease binding or identity-box selection.

The default token loader creates one stable token at `AGENTBOX_HOME/token`, and
`defaultBoxConfig` installs it in every config that does not override it
(`src/box/docker.ts:124-160`). The multi-tenant compose allocator does override it with a
per-box token (`src/control/compose.ts:136-153`), but v2 never says the identity provisioner
must use that allocator or independently mint a non-exported token. Inside a current team
box, hostd receives the same `BOXD_TOKEN` as `AGENTBOX_TOKEN`
(`docker/box/entrypoint.sh:154-176`), while the `box` user has passwordless sudo and the
Dockerfile explicitly concedes that it can read hostd's state
(`docker/box/Dockerfile:46-62`).

The daemon listens on all container interfaces and treats the bearer as the access
control (`src/boxd/main.ts:640-644`). Current provisioning explicitly records that
per-container networks are reachable from other containers on the measured engine
(`src/box/docker.ts:407-425`). Once a token is shared or stolen, boxd has no second
identity or authorization check.

VERDICT:

The shipped fix closes an unauthenticated host-to-box hop; it does not close the
team-to-identity trust boundary. V2 must require per-identity-box credentials, non-export
to all team boxes, authenticated box identity, routing authorization, rotation and
revocation. The listed negative probe cannot prove any of those properties. V1 fatal 4 is
relabelled, not closed.

## 6. THE “POSITIVE IMAGE MANIFEST” IS NOT A MANIFEST, AND “NOT NEEDED” IS NOT A BOUNDARY — fatal

SEQUENCE:

1. Build the proposed identity image by removing terminal/file-manager launchers and
   packages deemed unnecessary.
2. Keep the current desktop startup, browser wrapper, daemon and health probes so the X11
   desktop remains operable.
3. Bash remains required for the entrypoint, display supervisor and browser wrapper;
   Python remains required for display/probe utilities; Node remains required for boxd.
4. Any process in the image can still reach the unauthenticated loopback CDP endpoint and
   the access-control-disabled X server.
5. Acceptance reports “no unnecessary shell/interpreter,” but the remaining general
   execution surfaces have no enumerated capability boundary.

DESIGN SAYS:

The first build step is a positive manifest: no terminal, file manager, desktop execution
launchers, or shells/interpreters not needed at runtime, plus Chrome policy for
extensions, devtools, downloads, external protocols and dangerous schemes
(`docs/18-identity-box.md:209-213`).

ACTUALLY HAPPENS:

The current image installs the X/VNC/capture stack, general command-line tools, Python,
sudo and Node (`docker/box/Dockerfile:15-38`). It creates the runtime user with `/bin/bash`
and passwordless sudo (`docker/box/Dockerfile:46-67`). It copies shell and Python
operational programs into the image (`docker/box/Dockerfile:69-89`). The entrypoint itself
is a Bash process supervisor (`docker/box/entrypoint.sh:1-15`,
`docker/box/entrypoint.sh:81-110`); `start-display` is Bash and invokes `sh -c` for desktop
configuration (`docker/box/start-display:1-23`, `docker/box/start-display:195-221`);
`box-chrome` is Bash (`docker/box/box-chrome:1-10`); and `vnc-probe` is Python and imports
socket/subprocess support (`docker/box/vnc-probe:1-31`). These interpreters are needed by
the current runtime unless the desktop stack is rewritten.

The literal “no shells or interpreters not needed” condition is therefore achievable only
by classifying Bash, Python and Node as needed and retaining them. That may satisfy the
sentence, but it establishes no absence boundary. The exact programs capable of invoking
those retained interpreters, their UIDs, and their executable/writable inputs become the
security property; v2 does not specify them.

The proposed positive set is never enumerated. V2 gives no package list, executable list,
UID/mode policy, writable/executable mount rule, Chrome-policy JSON, allowed protocol
handlers, permitted CDP methods, or test artifact. Current Chrome policy contains only
four unrelated settings (`docker/box/Dockerfile:91-110`). Chromium starts with an
unauthenticated loopback debugging port, `--remote-allow-origins=*`, and `--no-sandbox`
(`docker/box/box-chrome:49-72`); the wrapper acknowledges that anything in the box can
drive the browser (`docker/box/box-chrome:49-56`). Xvfb independently has access control
disabled (`docker/box/start-display:110-114`). Removing dock icons changes discoverability,
not those authorities.

VERDICT:

This is a label for an unresolved image redesign. The qualifier “not needed” retains all
three powerful interpreter classes under the current desktop implementation, so it cannot
support v1's absent-binary argument. Until the design enumerates the exact retained
programs and removes or mediates raw X/CDP authority, v1 fatal 5 remains relabelled.

## 7. THE ENFORCEMENT-POINT TESTS DO NOT PROVE THEIR LISTED PROPERTIES — fatal

SEQUENCE:

1. Implement every test in the §4 table literally.
2. Use unique wrong credentials for the team-box probe, revoke between two top-level
   actions, grep only environment/profile files for secrets, and send `file:`/`data:` to
   the network proxy.
3. Each test passes.
4. Reuse a disclosed/shared valid daemon token; revoke during a composite action or an
   established CDP command; have an allowed server echo the substituted credential in its
   response; and navigate `file:` or `data:` locally.
5. Every claimed property is violated despite a green table.

DESIGN SAYS:

“The table is the design,” and anything not externally testable is not claimed
(`docs/18-identity-box.md:126-138`).

ACTUALLY HAPPENS:

The auth probe proves only rejection without a valid bearer; it does not prove valid
bearers are unique or inaccessible. The current source test has exactly that blind spot
(`src/boxd/upgrade-auth.test.ts:28-59`), and finding 5 gives a valid-token sequence.

The slow multi-action test proves only the boundary at which it revokes. Current click,
drag, held-key and typing implementations perform multiple effects inside one action
(`src/cua/x11-executor.ts:431-481`, `src/cua/x11-executor.ts:560-568`,
`src/cua/x11-executor.ts:705-730`). It does not test “the next effect,” nor does the table
name a browser test even though the browser's irreversible boundary is a separate CDP
WebSocket send (`src/boxd/cdp.ts:164-178`).

The secret test cannot prove “secrets never in the container.” In the transplanted proxy,
the real secret is substituted into URL/headers/body on the outbound request
(`/Users/chris/sdcard/source/openclaw/src/secrets/egress-proxy/proxy-server.ts:323-432`),
but the upstream response is piped back unchanged
(`/Users/chris/sdcard/source/openclaw/src/secrets/egress-proxy/proxy-server.ts:387-399`).
A permitted test origin can echo the credential it received; it then exists in browser
memory/DOM/cache while an environment/profile grep still passes.

The proxy cannot refuse `file:` or `data:` because neither produces an egress connection.
Current host policy explicitly returns those local schemes without network checks
(`src/host/web.ts:244-271`), and boxd sends the URL directly to `Page.navigate`
(`src/boxd/browser-service.ts:623-629`). Sending them “to the proxy” is not a test of the
typed-navigation path; an execution-local navigation gate is required.

The capture test's inventory is already false because `vnc-probe` reads raw framebuffer
bytes without a named primitive (`docker/box/vnc-probe:81-118`). The principal tests are
also not identical across paths today: HTTP merges the signed web-session identity
(`src/web/server.ts:1724-1738`), while the RFB upgrade derives its caller only from request
headers after generic authorization (`src/web/server.ts:3148-3168`).

VERDICT:

These are happy-path examples, not proofs of the row properties. Because v2 declares the
table to be the design, the mismatch is fatal: a conforming implementation can pass every
listed test while violating every security claim in the table.

## 8. THE QM/OPENCLAW PROXY TRANSPLANT DOES NOT SURVIVE A LONG-LIVED BROWSER — fatal

SEQUENCE:

1. Chromium authenticates one CONNECT tunnel with a lease/run token and opens TLS through
   the proxy.
2. The proxy resolves that token to a registered sentinel binding and captures the binding
   in the per-target TLS server.
3. The lease is revoked. `revokeRun` deletes only the token-map entry.
4. Chromium reuses the established CONNECT/TLS connection for a later HTTP request.
5. The captured registration still resolves and substitutes the real secret after revoke.

DESIGN SAYS:

OpenClaw makes sentinels inert by `tokens.delete`; v2 states the only inherited gap is
that an already-streaming request completes (`docs/18-identity-box.md:77-83`). It proposes
copying qm's fail-closed CONNECT authorization, resolved-IP checks and firewall belt
(`docs/18-identity-box.md:62-75`).

ACTUALLY HAPPENS:

OpenClaw authorizes at CONNECT (`/Users/chris/sdcard/source/openclaw/src/secrets/egress-proxy/proxy-server.ts:498-544`).
Its per-target TLS server closes over the `RegisteredRun` object and uses that same object
for every HTTP request on the server (`/Users/chris/sdcard/source/openclaw/src/secrets/egress-proxy/proxy-server.ts:435-454`).
`revokeRun` deletes the token map but destroys neither active sockets nor cached TLS
servers; only full proxy shutdown destroys sockets (`/Users/chris/sdcard/source/openclaw/src/secrets/egress-proxy/proxy-server.ts:610-625`).
Therefore the verified gap is larger than one streaming request: later requests on an
already-authorized persistent connection retain the captured binding.

The browser trust transplant is also missing. OpenClaw exports proxy and CA variables for
Node, OpenSSL/curl and Requests (`/Users/chris/sdcard/source/openclaw/src/secrets/egress-proxy/proxy-server.ts:573-608`);
it exports no Chromium trust configuration. Agentbox passes only a proxy command-line
argument to Chrome (`docker/box/box-chrome:59-71`). V2 supplies no Chrome CA installation,
pinning or policy contract, so its sentinel-swapping TLS MITM is not a transplantable
browser path as described.

QM's topology facts are narrower than v2's boundary. It creates one network and publishes
the daemon to host loopback (`/Users/chris/sdcard/source/qm/src/sandbox/local-sandbox.ts:228-267`),
but its local daemon client sends no authentication header
(`/Users/chris/sdcard/source/qm/src/sandbox/local-sandbox.ts:161-175`) and its own profile
declares egress enforcement `none` (`/Users/chris/sdcard/source/qm/src/sandbox/local-sandbox.ts:318-327`).
Its Envoy check does fail closed and resolve destinations
(`/Users/chris/sdcard/source/qm/deploy/egress-proxy/envoy.yaml:83-113`,
`/Users/chris/sdcard/source/qm/src/egress-authz-main.ts:96-169`), but the extra iptables
“belt” is explicitly best-effort and continues when NET_ADMIN is missing
(`/Users/chris/sdcard/source/qm/deploy/egress-proxy/start.sh:4-10`). None of those mechanisms
coordinates a persistent X11 browser, local schemes, CDP or capture audiences.

VERDICT:

The prior art is described inaccurately at its most security-critical edge. OpenClaw
does not make sentinels inert on established browser connections, and qm does not provide
the browser/X11 enforcement that agentbox needs. Stage A needs connection teardown or a
per-request revocation check, a forced non-bypassable browser route, and explicit Chromium
trust. V2 provides none.

## 9. CENTAUR'S BARRIER AND CINDY'S COMPARE-AT-COMMIT DO NOT STOP A DESKTOP EFFECT — fatal

SEQUENCE:

1. Revoke a principal while a desktop action is executing.
2. The centaur-style management acknowledgement times out or is unavailable.
3. The barrier proceeds after a delay because the proxy is assumed fail-closed.
4. The cindy-style scope comparison runs only after an asynchronous operation returns.
5. A click, keystroke or CDP dispatch already happened; rejecting a later state commit
   cannot undo it.

DESIGN SAYS:

V2 calls centaur's mechanism the shape of “revoked means acknowledged” and cindy's
mechanism a guard against late owner-scoped effects (`docs/18-identity-box.md:84-91`). It
then requires both at the identity-box execution fence (`docs/18-identity-box.md:220-222`).

ACTUALLY HAPPENS:

Centaur's barrier addresses a warm proxy whose five-second poll allowed the first LLM
call to beat config application by about 350 ms
(`/Users/chris/sdcard/source/centaur/services/api-rs/crates/centaur-sandbox-agent-k8s/src/iron_proxy.rs:61-77`).
It does poll the live pod's management endpoint for principal/config match
(`/Users/chris/sdcard/source/centaur/services/api-rs/crates/centaur-sandbox-agent-k8s/src/iron_proxy.rs:843-903`,
`/Users/chris/sdcard/source/centaur/services/api-rs/crates/centaur-sandbox-agent-k8s/src/iron_proxy.rs:1042-1134`).
But `wait_for_proxy_principal_applied` returns no success value, falls back to a blind
delay when management is unavailable, and explicitly proceeds on timeout
(`/Users/chris/sdcard/source/centaur/services/api-rs/crates/centaur-sandbox-agent-k8s/src/iron_proxy.rs:727-785`).
It is not an acknowledged-or-refuse barrier.

Cindy snapshots owner state around an account RPC and rechecks before changing durable
recovery state (`/Users/chris/sdcard/source/cindy/apps/desktop/src/main/maker-host/auth-adapters.ts:1313-1390`).
Its owner-scope key combines mode, owner and generation
(`/Users/chris/sdcard/source/cindy/apps/desktop/src/main/appSessionState.ts:112-127`). That
correctly drops a stale commit; it does not cancel the asynchronous RPC, much less undo
an external input effect. Agentbox's current CDP sender itself warns that a timed-out
command may already have run (`src/boxd/cdp.ts:164-178`).

VERDICT:

These cited mechanisms do not mediate agentbox's live X11 input and capture topology.
Centaur proves neither mandatory acknowledgement nor effect drain; cindy protects a
subsequent state mutation, not an already-dispatched external effect. They cannot be cited
as the missing fence. V2 must design that fence directly.

## 10. “SIGNED PRINCIPAL SESSION ON BOTH PATHS” DOES NOT AUTHENTICATE THE TAKEOVER TRANSITION — fatal

SEQUENCE:

1. A browser presents a valid long-lived UI session and requests the login page for an
   identity box.
2. HTTP resolves the signed session to a principal, but the RFB upgrade follows the
   current path that authorizes the cookie and derives caller/role from headers only.
3. No specified authority maps that principal to the identity record, display, current
   lease, or right to enter login mode.
4. No fresh-authentication or request-binding rule distinguishes a deliberate
   credential-entry transition from a stale session or ambient request.
5. The system can open a correctly signed session into the wrong identity display and
   still satisfy “signed on both paths.”

DESIGN SAYS:

Only the owner enters login mode, enforced by a signed principal session on HTTP and RFB
(`docs/18-identity-box.md:131-138`). The takeover route is to be keyed by
`{principal, identityBoxId, display}` and checked identically on the page and upgrade
(`docs/18-identity-box.md:217-219`).

ACTUALLY HAPPENS:

The current signed cookie proves only an identity string under a key derived from the UI
token (`src/web/session.ts:12-20`, `src/web/session.ts:42-60`) and lasts 30 days
(`src/web/session.ts:63-83`). HTTP merges it into caller identity
(`src/web/server.ts:1724-1738`). The RFB upgrade authorizes the request but calls
`callerOf(req.headers, ...)` directly for the driving role, without `readSession`
(`src/web/server.ts:3148-3168`). It then resolves a single current box origin and proxies
only a display-index path (`src/web/server.ts:1376-1425`,
`src/web/server.ts:3178-3214`).

V2 names the desired tuple but defines no identity registry, ownership relation, URL or
capability format, lookup authority, mismatch response, freshness requirement, CSRF
binding, reauthentication rule, or atomic coupling between HTTP transition and RFB
stream. A signature answers “who minted this identity string”; it does not answer “may
this principal enter this identity's private login now.”

VERDICT:

The owner-auth fatal is relabelled. The current two paths do not even resolve the same
principal, and v2 does not define the ownership authorization that would sit above
signature validity. A signed session is an input to the missing decision, not the
decision or its enforcement point.

## 11. RESTART RECOVERY IS STILL A REQUIREMENT SENTENCE, NOT A PROTOCOL — fatal

SEQUENCE:

1. A lease is active, a private login is in progress, and a recording or input action is
   in flight.
2. boxd crashes while the X server, browser, VNC servers and recorder survive.
3. Its supervisor starts a new boxd against the same desktop.
4. The new daemon listens before it reclaims orphan recorders; there is no durable lease
   record or epoch floor in the request protocol to reject pre-crash work.
5. Work, capture or a VNC stream is accepted before reconciliation, even though the
   design's audit later records a restore-or-revoke outcome.

DESIGN SAYS:

Build step 8 says to fence all pre-crash epochs before accepting work, reconcile each box,
record restore versus revoke, re-arm expiry, and recover login state closed
(`docs/18-identity-box.md:227-228`). Acceptance asks for an auditable lease fate and closed
login recovery (`docs/18-identity-box.md:249-252`).

ACTUALLY HAPPENS:

The current container deliberately restarts boxd in place so desktops and browser
sessions survive (`docker/box/entrypoint.sh:81-110`,
`docker/box/entrypoint.sh:129-139`), and Docker also uses `unless-stopped`
(`src/box/docker.ts:436-440`). Display ownership already has a persisted record precisely
because X and applications survive boxd (`src/boxd/displays.ts:79-93`). Recording has a
different recovery path: orphan encoders keep capturing, and the new daemon kills them
only after its server is listening (`src/boxd/record-service.ts:216-276`,
`src/boxd/main.ts:660-673`).

No current computer or browser request contains a lease/epoch
(`src/protocol/index.ts:99-120`, `src/protocol/index.ts:507-530`). V2 supplies no durable
lease schema, monotonic allocator, authoritative writer, startup ordering, reconciliation
request/response, old-epoch floor, login-state record, partial-box rule, timeout, or
terminal state. “Fence before accepting” does not state how a replacement daemon knows
which epoch is old or how host and box agree after either side alone restarts.

Section 9 also fails its own accounting. Its ninth row is usage attribution
(`docs/18-identity-box.md:254-266`), which was v1 finding 10 and was major. V1 fatal 11,
restart recovery, is absent from the claimed replacement ledger
(`docs/reviews/2026-08-28-identity-box.md:471-509`).

VERDICT:

V1 fatal 11 remains open and is hidden rather than replaced in §9. A buildable protocol
must define durable state and startup order such that no listener, capture source or input
consumer can operate before reconciliation establishes the new epoch floor and private
state. V2 has only the acceptance sentence.

## 12. MOST STAGE A SECURITY EFFECTS HAVE NO ENFORCEMENT POINT — major

SEQUENCE:

1. Implement only the six enforcement rows, because v2 says the table is the design.
2. A caller grants or selects a lease, maps a task to an identity/profile, approves work,
   exports a file, creates/restores/deletes a snapshot, migrates an old profile, archives
   the installation, upgrades one of two images, restarts a component, or assigns spend.
3. None of those state changes is governed by a refusal named in the table.
4. Tests for the six rows remain green while the omitted effect crosses an owner,
   identity, lifecycle or billing boundary.

DESIGN SAYS:

“The table is the design” (`docs/18-identity-box.md:126-129`), but the table contains only
daemon auth, next-effect fencing, secret substitution, egress, capture and login-mode
entry (`docs/18-identity-box.md:131-138`). The build order separately requires migration,
archive handling, restart and snapshot retention (`docs/18-identity-box.md:224-233`) and
leaves billing, multiple identity/profile binding, second-image lifecycle and capture
closability open (`docs/18-identity-box.md:268-286`).

ACTUALLY HAPPENS:

The following effects have **no enforcement point** in v2:

- minting, granting, selecting, expiring and terminating a lease;
- binding a lease to task, agent, requester, owner, origin, identity box and browser
  profile;
- initiating and completing the atomic transition into or out of private login, including
  draining existing RFB/input sessions;
- minting, storing, rotating and routing per-identity-box daemon credentials;
- authorizing, consuming once, delivering and deleting an export;
- creating, validating, restoring, retaining and crash-safely deleting a plaintext profile
  snapshot;
- migrating and proving deletion of legacy cookie/profile state, and excluding identity
  volumes from every archive path;
- reconciling host/box restarts and advancing the epoch floor before listeners start;
- building, versioning, negotiating, upgrading and rolling back the second image/protocol;
- assigning usage when requester and owner differ; and
- exporting, importing, expiring and revoking the alternative own-machine session
  transfer.

These omissions are observable in the existing surfaces. Approval lacks owner/lease/task
fields (`src/host/policy.ts:63-79`); export is still general `/fs/download`
(`src/box/client.ts:341-353`); there is one global box protocol
(`src/protocol/index.ts:383-398`); and the image build has one context, repository and tag
chain (`scripts/build-image.mjs:25-26`, `scripts/build-image.mjs:57-73`). The corresponding
v2 lifecycle question remains explicitly open (`docs/18-identity-box.md:280-282`).

VERDICT:

The enforcement-point organization is incomplete on its own terms. These are not
implementation details: they are the state-changing effects at which identity isolation
either becomes true or remains decorative. Several are independently fatal above; the
table's systemic omission is major because it lets an implementation declare conformance
without ever testing them.

## OVERALL VERDICT ON WHETHER V2 IS BUILDABLE AS A STAGE A PLAN

**Rejected. V2 is not buildable as a Stage A plan.** It is a failure catalog plus a build
order, not an implementable security protocol. The capture mechanism is directly refuted
by an existing framebuffer reader; the last-byte gate has no process topology; the effect
fence has no wire fields, authority or atomic boundary; task identity has no causal model;
daemon auth proves only possession of a potentially shared bearer; and the prior-art
revocation mechanisms are weaker than v2 claims.

The capture inventory is not closable under §5, so the takeover design must not be built
as written. Logging in on the person's own machine is better at removing the specific
coexistence of private input with agentbox capture/input paths, but it is not yet a safer
system because session transfer has no design. The next plan must choose and fully design
one of two architectures: exclusive observation/input mediation inside the identity box,
or an authenticated, revocable session-transfer protocol. V2 has designed neither.

## EXPLICIT PER-FATAL RULING: CLOSED VERSUS RELABELLED

| v1 fatal | v2 replacement | Ruling | Reason |
| --- | --- | --- | --- |
| 1. Capture choke point does not exist | source/sink model and per-source gate | **RELABELLED** | Detached `ffmpeg`/x11vnc processes have no last-byte gate, and `vnc-probe` is an omitted raw framebuffer reader. |
| 2. `MODEL_CALLS`-style enumeration is not mechanical | centralise, then prohibit raw primitives | **RELABELLED** | The prohibition enumerates spellings, not X/RFB authority; an existing Python protocol reader evades it. |
| 3. Router epoch cannot refuse an in-flight effect | box-local check between actions plus CDP check | **RELABELLED** | No lease/epoch reaches boxd, top-level actions contain multiple effects, and no revoke linearization/ack protocol exists. |
| 4. “No network path” is false | daemon auth as boundary | **RELABELLED** | Shipped auth proves a bearer on a host hop; v2 does not require unique, non-exported identity-box credentials or routing authorization. |
| 5. Removing routes does not remove browser escape hatches | positive image manifest and Chrome policy | **RELABELLED** | No positive manifest is specified; Bash/Python/Node, raw X and unauthenticated loopback CDP remain required by the current stack. |
| 6. Stage A requires machinery deferred to Stage B | task, approval, export and origin items “absorbed” | **RELABELLED** | The list supplies no causal task model, owner-bound approval state machine, read-once export protocol or enforcement contracts. |
| 7. “The owner” is unauthenticated at login/VNC | signed principal session on both paths | **RELABELLED** | HTTP and RFB do not currently resolve the same session identity, and signature validity is not authorization for an identity/profile/login transition. |
| 8. `login_private` stops capture, not input | input fence and drain | **RELABELLED** | No atomic transition, RFB classification/drain, composite-effect boundary or supervisor protocol is designed. |
| 11. Restart has no lease/privacy recovery protocol | §7.8 restart requirement | **RELABELLED** | No durable schema, epoch allocator, startup ordering or reconciliation handshake exists; §9 omits this fatal entirely. |

**CLOSED: 0. RELABELLED: 9.**

Section 9's ninth row is not one of those nine fatals. Its narrow assertion that
`recordAside` can now persist a principal is **VERIFIED** in
`src/host/usage.ts:320-352`, but the row does not close leased-spend attribution: the
principal-selection cache is per agent despite concurrent per-conversation turns
(`src/host/orchestrator.ts:722-741`, `src/agents/bus.ts:157-164`), and v2 leaves the payer
rule undecided (`docs/18-identity-box.md:274-276`). It is a real schema/call-site fix
substituted for an omitted fatal, not a closed identity-box billing design.

## THE THREE MOST IMPORTANT QUESTIONS V2 STILL FAILS TO ASK

1. **What single component owns exclusive X11 framebuffer and input authority, and what
   exact capability protocol lets the authenticated owner see/type while making every
   agent, model, recorder, diagnostic and view-only path physically unable to do so?**

2. **What durable, linearizable state machine binds message → turn → task → lease →
   identity/profile → effect, and what acknowledgement proves that every pre-revoke or
   pre-crash effect and connection is dead before ownership changes?**

3. **If takeover is abandoned, what is the complete security protocol for transferring a
   browser session from the person's machine—export authority, format, encryption,
   recipient/device attestation, compatibility, expiry, revocation, deletion and audit—and
   which threats does that protocol remove versus merely relocate?**
