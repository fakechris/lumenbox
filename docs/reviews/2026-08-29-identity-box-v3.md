# Third adversarial review: the identity box v3 (2026-08-29)

Method: read both prior rejections before v3, then trace the reduced claim through the
current container launcher, control plane, web/RFB authentication, agent registry,
orchestrator, tools, model wire, recorder and display processes. The review question is
not whether a single-tenant container is useful. It is whether v3 has shown that every
actor and data path it calls “the person's” is actually confined to one stable person.

Verdict: six fatal findings and one major finding. V3 genuinely closes part of the image
and daemon-auth problem by deleting the special-image architecture, using per-container
names for volumes and tokens, defaulting publications to loopback, and authenticating the
boxd upgrade before connecting upstream. Those are real improvements. They do not make
the owner, agent, session, model provider, registry, or live desktop single-tenant.

---

## 1. DROPPING THE INTRA-CONTAINER REQUIREMENT CONFUSES SINGLE-TENANT OWNERSHIP WITH TRUSTED EXECUTION — fatal

SEQUENCE:

1. The owner opens a hostile page in the ordinary browser. The semantic browser reads
   page/frame content and returns it to the agent as a tool result
   (`src/boxd/browser-service.ts:359-400`, `src/host/tools.ts:2016-2027`).
2. The page contains instructions that induce the model to use Bash, browser, or computer
   against the owner's own box. Model compliance with that text is a **HYPOTHESIS**, but
   prompt injection is a threat the shipped tool prompt itself recognizes
   (`src/host/tools.ts:1190-1194`).
3. The induced agent does not need to escape the container. The box image grants its user
   passwordless sudo, exposes the X socket directory mode 1777, and starts Xvfb with access
   control disabled (`docker/box/Dockerfile:46-67`, `docker/box/start-display:110-114`).
4. A computer result contains a screenshot, and screenshots/tool results are retained in
   the turn messages that are sent to the configured model provider
   (`src/host/tools.ts:1342-1413`, `src/host/turn.ts:1275-1329`,
   `src/host/openai-wire.ts:273-292`). The container boundary has held; the person's data
   has still crossed it through the intended model path.
5. Independently, a host with one global registry and one scalar `BoxClient` can resolve an
   agent without any box identity and then run that agent against whichever scalar box the
   orchestrator connected (`src/agents/registry.ts:192-234`,
   `src/host/orchestrator.ts:112-168`, `src/host/orchestrator.ts:485-530`). That is the
   current global-agent assumption v3 proposes to migrate, not evidence that agents are
   already per-box.

DESIGN SAYS:

Protecting a person from their own agent is a multi-tenant problem, while an identity box
is single-tenant; therefore the whole security claim can rest on nobody else being able to
reach the person's ordinary container (`docs/18-identity-box.md:24-45`). The host, model
provider, and any network path intentionally used by the person or their agent are simply
outside the box boundary (`docs/18-identity-box.md:60-67`).

ACTUALLY HAPPENS:

“One owner” and “one trusted execution principal” are different properties. The model is
fed external page text and screenshots, and a compromised turn acts with the owner's box
authority. That is a confused-deputy problem inside one tenant, not a second human tenant.
The product itself says the container is not a sandbox for untrusted code and that nothing
inside should be data the owner would not hand to the model
(`docs/02-product.md:105-110`). V3 may choose that threat model, but it cannot also claim
that the box protects the owner's authenticated browser state from their agent.

The “one person” premise also has no lifecycle. The existing control plane assigns a box
to a tenant, not a principal, and its role model permits multiple users in one tenant
(`src/control/store.ts:43-61`, `src/control/store.ts:69-107`). Removing a membership does
not make the gateway re-check that membership on each request; request authentication
checks suspension and the signed tenant session, while member removal only deletes the
membership row (`src/control/gateway.ts:259-291`, `src/control/admin.ts:226-239`). A box
whose person changes therefore has an old-session and old-data problem v3 does not name.

Nor does “their agent” mean one isolated process today. Registry profiles have creator,
visibility, tools, provider and display fields but no box identifier
(`src/agents/registry.ts:88-153`). Agent resolution lists one registry and resolves by
agent id/name alone (`src/agents/registry.ts:275-313`). A future shared agent, a reassigned
box, or a cross-box message has no authoritative rule saying which box and which person's
state it may use.

VERDICT:

**The requirement is droppable only after v3 narrows the product claim to “the owner fully
trusts every model-mediated action and every configured provider with every byte in the
box,” makes ownership immutable or designs reassignment, and forbids shared/cross-box
agents. V3 does none of those.** As written, the move relocates the prior failures from a
privacy gate into the definitions of “own agent,” “own provider,” and “one person.” The
container can successfully stop another container while the intended agent exfiltrates or
destroys the owner's state through authorized paths.

## 2. THE “VERIFIED” CONTAINER TABLE MIXES REAL DEFAULTS WITH OVERRIDABLE CONFIGURATION — fatal

SEQUENCE:

1. Start two named boxes. Give them distinct volume names and token files.
2. Set `AGENTBOX_TOKEN` in the host environment. `readBoxToken(containerName)` returns
   that same environment value before consulting either named token file; the code is
   literally `const env = process.env.AGENTBOX_TOKEN` followed by an immediate return
   (`src/box/docker.ts:165-174`).
3. Set `AGENTBOX_BOXD_PUBLISH_ADDRESS=0.0.0.0`. `runArguments` publishes boxd at that
   address because the code selects the environment value before the loopback default
   (`src/box/docker.ts:405-440`).
4. Supply `runArgs: ["--privileged", "-v", "/var/run/docker.sock:/var/run/docker.sock"]`.
   `BoxConfig` exposes arbitrary `runArgs`, and the launcher appends them directly to the
   Docker invocation (`src/box/docker.ts:67-110`, `src/box/docker.ts:510-535`).
5. The table continues to read as an invariant even though three rows are defaults or
   conventions that configuration can defeat.

DESIGN SAYS:

Section 2 marks six current properties with checkmarks: per-container storage; no
privileged mode/capability additions/Docker socket; separate display and process stacks;
loopback-only publication; authenticated boxd upgrades; and one token per container with
legacy fallback only for the default box (`docs/18-identity-box.md:47-58`).

ACTUALLY HAPPENS — CLAIM-BY-CLAIM:

1. **CONFIRMED — separate storage, at the launcher construction boundary.** Work and
   config volume names are derived from `containerName`, and the optional hostd volume is
   derived the same way (`src/box/docker.ts:497-509`, `src/box/docker.ts:510-527`). This
   confirms distinct named volumes, not that backups, host paths, or higher-level registry
   state are isolated.

   **RUNNING SYSTEM: UNVERIFIED.** The review-time `docker ps -a` query found no matching
   `agentbox` containers, so no live mounts could be inspected.

2. **REFUTED — “no privilege escape” is not an enforced property.** The built-in argument
   list does not itself add `--privileged`, `--cap-add`, or a Docker-socket mount, but the
   public config accepts `runArgs?: string[]` and appends it after all managed arguments
   (`src/box/docker.ts:67-110`, `src/box/docker.ts:510-535`). The exact flags the table says
   are absent can therefore be injected by a caller. Absence in one default argv is also
   not a proof that container escape is impossible.

   **RUNNING SYSTEM: UNVERIFIED.** There was no live container whose privileges or mounts
   could be checked.

3. **CONFIRMED — separate display/process construction, narrowly.** Each config emits a
   distinct `docker run --name <containerName>` and a per-container network name
   (`src/box/docker.ts:420-460`); the image starts its own Xvfb and VNC processes
   (`docker/box/start-display:110-114`, `docker/box/start-display:262-306`). This confirms
   how separately named containers are constructed. It does not prove live namespace
   separation in the absence of running containers, and arbitrary `runArgs` can still add
   shared host resources.

   **RUNNING SYSTEM: UNVERIFIED.** No matching live or stopped containers existed to
   inspect.

4. **REFUTED — loopback-only publication is a default, not an invariant.** The literal
   code is `process.env.AGENTBOX_BOXD_PUBLISH_ADDRESS ?? "127.0.0.1"`, and that value is
   used for both boxd and UI publication (`src/box/docker.ts:405-440`,
   `src/box/docker.ts:510-527`). A documented environment override can publish on a LAN
   interface. The narrow statement “the default is loopback” is **CONFIRMED** by the same
   lines and by the focused launcher test (`src/box/docker.test.ts:25-55`).

   **RUNNING SYSTEM: UNVERIFIED.** No live port binding was available.

5. **CONFIRMED — boxd authenticates upgrades before opening the upstream socket.** The
   upgrade handler calls `authorized(req)` first, returns 401 on failure, parses the
   upstream only after authorization, and calls `netConnect` afterward
   (`src/boxd/main.ts:585-630`). The host upgrade proxy strips browser authorization and
   supplies the box token (`src/web/server.ts:3224-3261`). The focused source-order and
   proxy tests cover those two mechanics (`src/boxd/upgrade-auth.test.ts:28-59`). This is
   host-to-box bearer authentication, not principal-to-box ownership; the boxd source says
   so explicitly (`src/boxd/main.ts:600-602`).

   **RUNNING SYSTEM: UNVERIFIED.** No live upgrade endpoint existed for an acceptance test.

6. **REFUTED — “one key per container” is not true across all resolution paths.** Named
   token files exist, and the legacy file fallback is correctly limited to the default
   container (`src/box/docker.ts:124-154`, `src/box/docker.ts:165-184`). The focused tests
   confirm distinct named tokens and that narrow legacy rule
   (`src/box/docker.test.ts:133-178`). The legacy file by itself therefore does **not** fan
   out to arbitrary named boxes.

   The hole is the higher-priority global `AGENTBOX_TOKEN`, which is returned for every
   container name (`src/box/docker.ts:165-174`), plus callers that still omit the name.
   `AttachedBoxProvisioner` falls back through `readBoxToken()` with no argument, and the
   static control allocator does the same (`src/box/provisioner.ts:59-76`,
   `src/control/main.ts:95-110`). The CLI egress relay also calls `loadBoxToken()` without
   a container name (`src/cli.ts:776-792`). By contrast, the compose allocator's per-tenant
   token is explicit (`src/control/compose.ts:136-187`). V3 has implemented a safer named
   path but has not made unnamed/global resolution impossible.

   **RUNNING SYSTEM: UNVERIFIED.** With no containers, the effective token identity could
   not be compared end to end.

VERDICT:

**Three narrow construction claims are confirmed; three security invariants are
refuted.** V3 must distinguish “default configuration,” “enforced invariant,” and “live
deployment fact.” Remove or constrain arbitrary Docker arguments for identity boxes,
make non-loopback publication an explicit unsafe mode, reject global/unnamed token
resolution in multi-box paths, and add a deployment acceptance check. The legacy fallback
is not the direct fan-out bug v3 feared; the global environment override and unnamed
callers are.

## 3. A SIGNED SESSION PLUS A BOX-SHAPED URL IS NOT THE OWNERSHIP DECISION — fatal

SEQUENCE:

1. A browser presents the current UI token in a query parameter. `authorize` accepts that
   query token, and `callerOf` treats an authenticated request with no principal header as
   the owner (`src/web/auth.ts:14-18`, `src/web/auth.ts:64-85`,
   `src/web/auth.ts:165-204`). No signed principal session is required.
2. The HTTP desktop route does read a signed session, but its caller retains the owner
   role unless a separate mutation-refusal path rewrites it
   (`src/web/server.ts:1747-1783`, `src/web/server.ts:1834-1849`). A viewer session can
   therefore reach the driving route under the current role resolution.
3. The RFB upgrade authorizes token/cookie possession and then calls `callerOf(req.headers)`
   without `readSession`; it never applies the signed session identity or role
   (`src/web/server.ts:3194-3221`). HTTP and RFB do not make the same principal decision.
4. Add `/box/alice/desktop/0` to the URL without changing the resolver. The server still
   uses one scalar `cachedOrigin` and one provisioner endpoint for every desktop proxy
   (`src/web/server.ts:1399-1495`, `src/web/server.ts:3224-3261`). The route name has not
   selected or authorized Alice's box.
5. Give a box to a new person. Existing web sessions remain 30-day stateless HMAC cookies
   containing only a random identity; they contain no box id, session id, issue time,
   authentication time, or revocation lookup (`src/web/session.ts:12-20`,
   `src/web/session.ts:35-83`).

DESIGN SAYS:

HTTP and RFB will both require a signed principal session, the route will identify the
requested box, and the host will resolve that session only to the person's own box
(`docs/18-identity-box.md:74-84`).

ACTUALLY HAPPENS:

A session signature proves that one server minted a blob. A route segment says which box
the caller requested. Neither proves that the principal currently owns that box. The
missing authority is a durable principal-to-box assignment with status and generation,
consulted by a common HTTP/RFB resolver on every new connection. The existing hosted
gateway is useful prior art because its session contains `userId`, `tenantId`, and role
(`src/control/gateway.ts:91-120`), but it still selects a box by tenant and does not
re-check membership on each request (`src/control/gateway.ts:259-291`,
`src/control/gateway.ts:312-348`). It cannot be copied as a person-to-box proof.

The current token-in-URL bootstrap is explicitly acknowledged as visible to history,
referrers and screenshots until client JavaScript removes it
(`src/web/app-html.ts:1010-1028`). If v3 continues accepting that token as direct-owner
authentication, it contradicts the signed-principal requirement and turns any token leak
into owner access. The box token should authenticate only the host-to-box hop, not a human
principal.

Classic attacker-chosen session fixation is **REFUTED for the current invite-login flow**:
the server generates a fresh random web identity when redeeming the invite
(`src/web/server.ts:2061-2115`). The adjacent lifecycle failure is real: there is no
specified rotation on ownership/login transition and no server-side session record to
revoke when a box changes hands (`src/web/session.ts:35-83`). CSRF exploitability of a
future ownership/takeover endpoint is **UNVERIFIED** because v3 specifies no endpoint,
method, origin check, anti-CSRF token, or reauthentication rule. That absence must be
resolved before the endpoint is buildable, rather than filled in after implementation.

Concretely, v3 must add:

- a persisted `principalId -> boxId` assignment with active/revoked state and an ownership
  generation;
- a signed session carrying principal, session id, box scope, role, issue/authentication
  time, backed by revocable server state;
- one resolver used by HTTP, RFB and every box API, with the box id parsed from the route
  and the resolved origin cache keyed by box id rather than one `cachedOrigin`;
- removal of raw UI-token owner/admin fallback on identity routes;
- one role decision that makes view-only sessions physically unable to select the driving
  upstream; and
- POST plus origin/CSRF validation, fresh authentication, session rotation, token rotation,
  connection termination, and old-profile handling for ownership changes.

VERDICT:

**Section 3.1 names two inputs to authorization but omits the authorization state machine.**
It is buildable only after ownership, role, revocation, route resolution and session
lifecycle are designed together. The current scalar origin, direct bearer-owner path,
and divergent HTTP/RFB identity logic are concrete counterexamples.

## 4. BOX-SCOPED AGENTS REQUIRE AN ORCHESTRATOR AND STATE TOPOLOGY, NOT A MEMORY DIRECTORY — fatal

SEQUENCE:

1. Provision boxes A and B but keep the current host orchestrator. It owns one registry,
   one bus and one scalar box client (`src/host/orchestrator.ts:112-168`,
   `src/host/orchestrator.ts:428-503`).
2. `ensureDefaultAgent` sees that the global registry is non-empty and returns its first
   agent. It creates the four-member `STARTER_TEAM` only when that registry is empty
   (`src/host/orchestrator.ts:911-1028`). Box B therefore does not get an independently
   scoped default team.
3. A turn receives every registry teammate and the merged shared memory assembled across
   registry agents (`src/host/turn.ts:877-914`, `src/agents/registry.ts:714-769`). Moving
   one memory file does not change that resolver.
4. `Fork` starts another conversation for the same global agent and bus; `Delegate` runs a
   job through the scalar `context.box`; `SendToAgent` resolves the target from the same
   registry and bus (`src/host/tools.ts:1459-1563`, `src/host/tools.ts:2198-2218`). None of
   those messages carries a box id.
5. The automatic audit reviewer is one named registry agent that reads another agent's
   transcript and is launched as a background prompt
   (`src/host/orchestrator.ts:292-404`, `src/host/orchestrator.ts:1013-1026`). If the
   reviewer is global, it crosses boxes; if it is local, there is no current routing rule
   selecting the local reviewer.

DESIGN SAYS:

An agent definition and its memory will belong to one box; no agent, shared memory, or
login profile will be visible across boxes (`docs/18-identity-box.md:86-95`).

ACTUALLY HAPPENS:

The registry root defaults to one global `~/.agentbox/agents`; profile, transcript and
memory paths are keyed by agent/conversation, not by box
(`src/agents/registry.ts:192-234`). Profiles have no `boxId`
(`src/agents/registry.ts:88-153`). The shared-memory renderer merges shards from the whole
registry (`src/agents/registry.ts:714-769`), and the prompt presents that team memory as
facts (`src/host/prompt.ts:643-650`, `src/host/memory.ts:294-315`).

The omitted state is broader than memory. The durable inbox and task board each default
to one global file (`src/agents/inbox.ts:28-30`, `src/host/tasks.ts:40-42`), while a task
has requester, assignee, reviewer and conversation but no box field
(`src/host/tasks.ts:76-90`). Display ownership is explicitly an accident guard rather
than a security boundary because registry agents share the filesystem
(`src/agents/registry.ts:506-533`). Transcripts, plans/todos, inbox, tasks, policy,
approvals, schedules, usage and reviewer selection all need the same scope decision.

Two implementable topologies exist, and v3 chooses neither:

1. **One orchestrator/registry/bus/state root per box.** Fork, Delegate, starter-team and
   audit operations stay local by construction. `SendToAgent` cannot cross boxes unless a
   separate broker performs explicit source-box, destination-box, principal and payload
   authorization.
2. **One multi-box orchestrator.** Every profile, conversation, message, task, memory
   shard, scheduled run, usage record, tool context and `BoxClient` lookup must carry a
   mandatory box id, and all resolvers must reject a missing or mismatched id.

VERDICT:

**Section 3.2 is not achievable as a file-layout patch.** Under the current scalar-box
orchestrator, agent resolution and tool execution can disagree about which box an agent
belongs to. V3 must select a topology and specify how Fork, Delegate, SendToAgent,
STARTER_TEAM, shared memory and the audit reviewer behave at the boundary. Until it does,
“one agent belongs to one box” is an aspiration with no routing authority.

## 5. “NO TURN IS RUNNING” IS NOT A SECURITY STATE — fatal

SEQUENCE:

1. An agent calls `AskUser` before the person takes over. The implementation returns text
   telling the model to stop; it sets no durable blocked state and acquires no human-input
   fence (`src/host/tools.ts:1750-1802`). The generic turn loop appends the tool result and
   can continue to another model/tool iteration (`src/host/turn.ts:1730-1746`).
2. While the person types, a scheduled routine starts a background prompt. The scheduler
   dispatches ordinary prompts in the background, and scheduled skills may be authored by
   agents (`src/host/orchestrator.ts:241-290`, `src/host/skills.ts:61-99`,
   `src/host/skills.ts:285-314`). Per-agent budget support explicitly exists for an agent
   acting on a routine it wrote for itself (`src/host/policy.ts:98-106`).
3. Or the audit reviewer starts another background turn
   (`src/host/orchestrator.ts:354-404`). Or a second conversation for the same agent runs:
   the bus permits concurrent different conversations, and its exclusivity key is
   agent-plus-conversation (`src/agents/bus.ts:157-175`, `src/agents/bus.ts:455-579`).
4. The display lease is re-entrant by agent id and has no state representing a human VNC
   driver (`src/box/display-lease.ts:20-37`). A concurrent conversation for the same agent
   can therefore reacquire it while the person is present.
5. A computer batch returns a screenshot after every batch
   (`src/cua/x11-executor.ts:357-416`). A compromised process can also use the same
   container's X/RFB authority because X access control is disabled and local VNC servers
   continuously poll the framebuffer (`docker/box/start-display:110-114`,
   `docker/box/start-display:262-306`).
6. If recording was active, ffmpeg independently reads X with `x11grab`; it can survive a
   boxd crash as an orphan, and the recorder API has start/stop but no pause/resume state
   (`src/boxd/record-service.ts:80-126`, `src/boxd/record-service.ts:216-226`,
   `src/boxd/record-service.ts:280-324`, `src/boxd/main.ts:429-441`).

DESIGN SAYS:

Password protection is mostly free because an agent screenshots only when it calls the
computer tool, the agent is blocked waiting for the person, and there is no agent turn
running while the person types. The recorder can be paused during takeover
(`docs/18-identity-box.md:97-118`).

ACTUALLY HAPPENS:

There is no box-wide “human takeover” state consulted by prompt admission, schedules,
audit, the bus, display acquisition, computer execution, VNC upgrades, CDP, or recorder
processes. `AskUser` is model-facing prose, not a scheduler barrier. “The foreground turn
is expected to stop” cannot imply “no turn in this box is running.”

The progress poller is one point v3 does **not** need to fear as a capture sink: it reads a
progress file and explicitly does not capture the desktop
(`src/web/server.ts:680-753`). That is a genuine negative finding. It also provides no
privacy protection; it merely reports progress while a prompt is in flight.

The recorder claim is inaccurate in two ways. There is no pause operation in the shipped
route set, and the capture child is deliberately recoverable as an orphan after daemon
failure (`src/boxd/main.ts:429-441`, `src/boxd/record-service.ts:216-226`). The display
supervisor also repairs the VNC/display stack independently
(`src/boxd/displays.ts:206-265`). A future pause requires an acknowledged process-state
transition and crash recovery ordering, not just a UI toggle.

V3's residual-risk sentence understates timing. The own agent/provider can receive pixels
or page content **during** credential entry if any concurrent turn or capture process is
active, not only later when the agent uses the logged-in browser. Browser semantic
snapshots do redact password-field values (`src/boxd/browser-snapshot.ts:146-181`), but
that does not stop framebuffer readers or prove that every other input/capture path is
absent.

VERDICT:

**The password-protection argument is refuted by current concurrency and process
lifetimes.** V3 either needs to withdraw password protection completely and say the owner
must never type secrets into a model-visible box, or reintroduce a box-wide, fail-closed
takeover protocol that fences new and running turns, schedules, audit, all agents,
computer/CDP access, recorder and non-owner VNC connections before acknowledging entry.
That is the supposedly dropped intra-container requirement returning through §4.

## 6. THE BUILD ORDER HIDES MOST OF V2 INSIDE FIVE SMALL-SOUNDING STEPS — fatal

SEQUENCE:

1. Implement “principal session and routed desktop.” It immediately requires ownership
   persistence, revocation, session rotation, a per-box resolver/cache, unified HTTP/RFB
   roles and ownership-change connection teardown—the missing machinery in finding 3.
2. Implement “second ordinary box.” The hosted allocator can create one container per
   tenant, but the non-hosted orchestrator still owns one provisioner/box and the static
   control path uses the default unnamed token (`src/control/allocator.ts:56-66`,
   `src/host/orchestrator.ts:485-503`, `src/control/main.ts:95-110`).
3. Implement “move agent and memory.” The global registry, bus, tools, schedules, reviewer,
   inbox and task log force the topology decision in finding 4.
4. Implement “pause recording.” The recorder is a detached process with orphan recovery,
   not a frame-by-frame daemon call (`src/boxd/record-service.ts:80-126`,
   `src/boxd/record-service.ts:216-226`).
5. Implement “task-scoped file transfer.” The wire operations contain path and bytes but
   no task, owner, recipient, one-use grant, expiry or audit binding
   (`src/protocol/index.ts:400-421`). Tasks themselves contain no box or transfer grant
   (`src/host/tasks.ts:76-90`).

DESIGN SAYS:

Those five steps are the complete first build; leases, epochs, capture inventories,
second images, broker protocols and fine-grained revocation are unnecessary
(`docs/18-identity-box.md:129-144`). Coarse revoke is stop the box, rotate its token, or
delete it; protecting the person from their own agent and brokered credential injection
are explicit give-ups (`docs/18-identity-box.md:146-156`).

ACTUALLY HAPPENS:

The second image and capture-inventory work really is gone. The remaining nouns are not
small, however:

| v3 step | Hidden minimum protocol |
| --- | --- |
| Principal session + route | Current ownership assignment, session issue/revoke/rotate, HTTP/RFB equivalence, per-box origin resolution, role-to-drive mapping, reassignment teardown. |
| Second ordinary box | Per-box orchestrator topology, named-token-only resolution, hostd placement, lifecycle and recovery. |
| Move agent + memory | Box id on registry and every durable/queued record, or physically separate registries/buses; defined Fork/Delegate/SendToAgent/audit behavior. |
| Pause recording | Acknowledged stop/pause, orphan reconciliation, startup ordering, and a box-wide admission fence if it is meant to protect typing. |
| Task-scoped transfer | Source box, destination principal/box, immutable task/effect id, exact object, expiry, one-use consumption, audit, cleanup and retry semantics. |

The coarse-revoke give-up is also a hidden requirement. Token rotation does not terminate
an RFB tunnel that boxd already authorized and connected; after the one authorization
check, the handler pipes the upgraded socket to the upstream
(`src/boxd/main.ts:585-630`). Stopping a box while an effect is in flight can leave its
outcome unknown: the client explicitly says timeouts and crashes may leave operations
running or effects unknown (`src/box/client.ts:38-48`, `src/box/client.ts:160-168`). V3
need not build fine-grained revocation, but it must define what coarse revoke acknowledges,
which existing connections die, and what survives restart.

“The own agent is trusted” is not a harmless give-up when the agent consumes adversarial
web content and sends tool context to a provider (`src/host/tools.ts:1190-1194`,
`src/host/turn.ts:1311-1329`). It silently gives up the very credential and private-state
protection §4 still advertises. Similarly, brokered credential injection may be a later
feature, but then v3 must say login secrets typed into this box are in model-visible trust
scope; it cannot treat password protection as free.

VERDICT:

**The build order is smaller than v2 only because it removes the special image and claims
less about intra-box secrecy. It is not buildable in the listed increments.** Steps 1–3
still require a coherent ownership/routing/state migration, while steps 4–5 reintroduce
process fencing and task-bound transfer semantics. The give-ups are legitimate only if
the product claim is narrowed to match them and coarse revocation is specified as an
observable protocol.

## 7. V3 SILENTLY DROPS CROSS-BOUNDARY PROTECTIONS IT STILL NEEDS — major

SEQUENCE:

1. An implementation satisfies the literal plan: route the desktop, create per-name
   volumes/tokens, move the agent memory directory, and pause one recorder.
2. It leaves generic box filesystem APIs authorized only by the box bearer. Those APIs
   read, write, download and upload arbitrary named paths without principal, task, owner
   or recipient fields (`src/box/client.ts:326-354`, `src/protocol/index.ts:400-421`).
3. It backs up the box config volume that v3 admits contains login state. The current
   backup set includes both work and config volumes
   (`src/box/docker.ts:34-51`, `src/box/docker.ts:739-775`).
4. It reassigns or deletes the box without a rule for sessions, profiles, transcripts,
   recordings, archives, provider-retained content, queued work or live tunnels.
5. The implementation declares identity isolation complete because none of those
   protections appears in the conformance claim.

DESIGN SAYS:

V3 narrows the promise to a person-specific container, agent and memory, a protected
desktop route, ordinary full browser use, and coarse deletion/revocation
(`docs/18-identity-box.md:11-20`, `docs/18-identity-box.md:74-95`,
`docs/18-identity-box.md:146-156`). It explicitly acknowledges that config archives carry
logins (`docs/18-identity-box.md:120-127`).

ACTUALLY HAPPENS:

At minimum, an identity-box design still needs to claim and test:

- **complete route coverage:** principal-to-box authorization for desktop HTTP/RFB,
  filesystem APIs, recordings, uploads/downloads, terminal/browser operations and any
  host proxy—not only a route named “desktop”; boxd otherwise accepts one bearer for all
  non-health HTTP routes (`src/boxd/main.ts:522-537`);
- **ownership lifecycle:** assignment, reassignment, removal, suspension, logout, session
  and token rotation, termination of old connections, wipe/retention and acknowledgement;
  the current control session can outlive membership removal
  (`src/control/gateway.ts:259-291`, `src/control/admin.ts:226-239`);
- **all durable state:** profiles, transcripts, plans/todos, shared memory, inbox, tasks,
  schedules, approvals, usage and audit state—not merely “agent and memory”; several
  current defaults are global (`src/agents/registry.ts:192-234`,
  `src/agents/inbox.ts:28-30`, `src/host/tasks.ts:40-42`);
- **egress and provider trust:** which DOM text, screenshots, files, prompts and login
  state may be sent to which provider, and how a prompt-injected turn is bounded; current
  turns send composed messages to the provider (`src/host/turn.ts:1311-1329`);
- **backup/archive semantics:** encryption, access, identity binding, retention, deletion,
  restore ownership and legacy-profile migration for archives that include the config
  volume (`src/box/docker.ts:739-775`);
- **cross-box collaboration:** explicit task/export authority, recipient binding, expiry,
  one-use/retry behavior, audit and cleanup before `SendToAgent` or file transfer crosses a
  box; current inter-agent messages carry no box identity
  (`src/agents/bus.ts:38-88`, `src/host/tools.ts:2198-2218`); and
- **non-owner access:** whether support, viewer and audit principals exist and whether they
  may see or drive. Both current role models include viewer/non-owner roles
  (`src/web/auth.ts:38-53`, `src/control/store.ts:43-61`).

VERDICT:

This is a major systemic omission rather than a seventh independent mechanism failure:
several items are already fatal in findings 1–6. But without this claim surface, a build
can pass v3 while leaking through an unlisted API, archive, provider, stale session or
cross-box message. Reducing a requirement is legitimate only when the design records the
resulting trust boundary and preserves every protection still necessary at crossings.

## WHAT V3 CLOSED

The prior two reviews found no closed fatal. V3 changes that record, but the distinction
between **CLOSED**, **PARTIALLY CLOSED**, and **WITHDRAWN** matters.

| Prior problem | V3 ruling | Evidence |
| --- | --- | --- |
| Special identity image needs a positive manifest, build/version negotiation, compatibility and rollback | **CLOSED BY ARCHITECTURE REMOVAL.** V3 uses the ordinary full browser image and no longer claims a reduced identity image (`docs/18-identity-box.md:38-45`, `docs/18-identity-box.md:129-144`). This is a genuine simplification, not relabelling. | The current launcher has one image/container config path (`src/box/docker.ts:53-110`). |
| Unauthenticated boxd desktop upgrade | **CLOSED for the host-to-box hop.** Authentication precedes upstream connection, and the host supplies the box token. | `src/boxd/main.ts:585-630`; `src/web/server.ts:3224-3261`; focused tests at `src/boxd/upgrade-auth.test.ts:28-59`. |
| One global token file fans out to every named box | **PARTIALLY CLOSED.** Named token paths and default-only legacy fallback are real; global `AGENTBOX_TOKEN` and unnamed callers keep the absolute claim open. | `src/box/docker.ts:124-184`; `src/box/docker.test.ts:133-178`; `src/box/provisioner.ts:59-76`. |
| LAN-reachable default publication | **CLOSED AS A DEFAULT, not as an invariant.** Managed publication defaults to `127.0.0.1`; an environment override can reopen it. | `src/box/docker.ts:405-440`; `src/box/docker.test.ts:25-55`. |
| False claim that archives omit login/session material | **CLOSED AS DOCUMENT HONESTY.** V3 now says config archives carry logins. It has not designed archive authorization or deletion. | `docs/18-identity-box.md:120-127`; actual backup volumes at `src/box/docker.ts:739-775`. |
| Capture inventory, last-byte gate, in-flight epoch fence, restart privacy state, secret-blind agent, fine revocation | **WITHDRAWN, NOT CLOSED.** V3 no longer promises these. Its §4 password argument nevertheless depends on stopping the same concurrent capture/turn paths (`docs/18-identity-box.md:97-118`). | Current concurrent turns and detached recorder remain (`src/agents/bus.ts:157-175`; `src/boxd/record-service.ts:216-226`). |
| Authenticated owner routing and box-scoped agent/memory | **STILL OPEN.** V3 correctly keeps them as work rather than calling them complete. | Scalar origin/box and global registry remain (`src/web/server.ts:1399-1495`; `src/host/orchestrator.ts:485-503`; `src/agents/registry.ts:192-234`). |

The net result is **three genuine narrow closures**: the special-image architecture is
gone, the boxd upgrade host hop is authenticated, and loopback/per-name token behavior is
materially better by default. The token and publication properties still need enforcement
before they can support v3's whole security claim. V3 also honestly admits archive-carried
logins; that closes a false statement, not an exposure.

## OVERALL VERDICT ON WHETHER V3 IS BUILDABLE AS WRITTEN

**REJECT. V3 is not buildable as written.** It needs specific architectural changes
before implementation: a durable principal-to-box ownership lifecycle; one revocable
HTTP/RFB/API session resolver; a per-box orchestrator/registry/state topology or mandatory
box identity on every record and tool; enforced named-token and loopback/container
configuration; and an honest takeover decision—either no secret typing in the box, or a
box-wide fail-closed fence over turns, schedules, agents, VNC and recording.

The decision to drop protection from a person's own agent is **wishful as written, not
sound engineering**. It can become sound engineering if the product explicitly treats the
agent, prompt-injected model behavior, configured model provider, and every process inside
the box as fully trusted with all owner data; forbids cross-box/shared agents; and designs
box reassignment as revoke-and-wipe or an equivalent lifecycle. V3 presently makes the
stronger privacy claim while adopting the weaker trust model.

## THE THREE MOST IMPORTANT QUESTIONS V3 FAILS TO ASK

1. **What durable authority says principal P owns box B now, and what exact sequence
   revokes old HTTP/RFB sessions, bearer tokens, live tunnels, queued turns, profiles,
   archives and provider access before B is reassigned, restored or deleted?**

2. **What single box-wide state prevents every foreground, background, scheduled,
   cross-agent and audit turn—and every computer/CDP, recorder and non-owner VNC path—from
   observing or driving while the person types, or will the product explicitly forbid
   typing secrets into the box?**

3. **What mandatory box/principal/task lineage follows an agent through registry lookup,
   STARTER_TEAM creation, Fork, Delegate, SendToAgent, shared memory, transcripts, inbox,
   schedules, usage, provider calls, backup and export, and which component refuses a
   missing or mismatched lineage?**
