# Identity boxes: login state as a per-person container

Status: **design awaiting adversarial review** (per [13-design-review.md](13-design-review.md)).
Not scheduled and not estimated until the review has run — the estimate comes after the
review, not before, because the last time this area was estimated the reviewer showed the
estimate had not counted the subject.

This document is the engineering carved out of the product plan's identity section: the
decisions were made there, the machinery was deliberately moved here so it could be
designed, attacked and costed on its own. The review that forced the split found three
specific holes ("停录≠停截图;只读位≠COW;无可信填充事件") — they are carried below as
acceptance conditions, verbatim, in §6.

## 1. Decisions already made — not up for re-litigation here

1. **The identity boundary is the container boundary.** Measured, not argued: inside one
   box, one root, `bash` reads any browser profile on the disk, and passwordless sudo
   removes the last speed bump. Per-user isolation inside a shared container is not a
   hardening problem, it is a category error. One principal's login state lives in one
   container that is theirs.
2. **Login state belongs to a principal; secret text belongs nowhere.** Cookies and
   sessions may live in an identity box, under lease, revocable. Passwords, API keys and
   app secrets are never at rest in *any* box — the person types them on a screen the
   system is deliberately not watching (§4.3). ("秘密文本永不进 box;登录态进身份仓,
   按 principal 一仓、按租约使用、按容器隔离.")
3. **The team box goes login-free — and that is a migration, not a status quo.** Today's
   box is *not* clean-on-rebuild: the `.config` volume persists browser logins by design,
   and the upgrade archive explicitly includes browser sessions. Both must change (§4.7,
   §3.8) before the sentence "重建即干净" becomes true.
4. **Takeover login.** The person logs in with their own hands on the identity box's
   screen. The agent never sees the password; the system provably does not record the
   window (§3.6). The user story, in the words the product will use:

   > "你在它的屏幕上自己登录,像把工位电脑借给助理。全程录像,登录那一段例外——
   > 你能看到红灯。做完你点退出。我们存不到你的密码。你可以随时收回。"

5. **Single-user first.** The current installation has one human. Stage A (§5) is built
   for exactly that and cheats nowhere that Stage B would have to un-cheat.

## 2. Vocabulary

- **Identity box** — a container holding one principal's login state: a browser with a
  persistent profile, its own display, a *narrowed* boxd. Not a workstation: it has no
  shell surface and no team workspace.
- **Lease** — a task-scoped, origin-scoped, expiring grant to route actions through an
  identity box: `{principal, taskId, origins[], expiresAt, epoch}`.
- **Attach = routing.** A team agent using someone's identity does not receive their
  profile; its browser/desktop actions for leased origins *execute in the identity box*,
  routed by the host. Nothing is copied, so there is nothing to un-copy on revoke.
- **login_private** — the identity box's fail-closed privacy state: while set, every
  capture path refuses and the person can see that it refuses (§3.6).

## 3. Architecture

### 3.1 One tenant, many boxes

[09-tenancy.md](09-tenancy.md) decided one tenant = one team = one box. That box remains
**the team box** — the workstation, the only place with a shell, jobs and the work
directory. Identity boxes are additional containers under the same tenant: at most one
per principal who has any login state, created on first login, stopped when idle.

The control plane for this, near-term, is the host process itself: the provisioner gains
`createIdentityBox(principal)` / `connect` / `stop` / `destroy`, and a registry maps
principal → container. The [08-control-plane.md](08-control-plane.md) BoxAllocator shape
absorbs this later without change of interface — an identity box is a box with a narrower
service set and an owner.

**Routing is the host's monopoly.** The host holds one BoxClient per container. The team
box has no route to any identity box — no shared network namespace, no shared volume, no
address. A tool call executes in an identity box only because the host's router chose it,
and the router chooses it only under a live lease (§3.3). This is the "BoxClient 可信路由
层" the review demanded by name: trust lives where the credential already lives, on the
host.

### 3.2 What an identity box runs — and pointedly does not

Inside: Xvfb + window manager, one browser with the persistent profile (the only login
state store), and a boxd built from the existing services but **narrowed to: computer
(input + screenshot), browser-service, clipboard, record-service**. No shell-service, no
fs-service, no job-service. The reasoning is the same measurement as decision 1: a shell
beside a profile reads the profile — including a shell driven by a well-meaning agent
under lease. What is not running cannot be talked into it.

No team workspace mount. Files cross the boundary only by §3.5.

The narrowed boxd is a build-time composition, not a runtime flag: the identity box image
simply does not contain the services. A flag can be flipped by whatever sets flags; an
absent binary cannot.

### 3.3 Leases: grant, fence, revoke

**Grant.** A lease is asked for as an approval and delivered to the **identity owner**,
not to whoever last drove the agent. This is the "定向审批投递" the product plan already
requires for other reasons; identity is the case that makes it non-negotiable, because
the requester and the owner are different people precisely when it matters. (Stage A:
owner == requester == the one user; the delivery targeting is still built, because it is
the part Stage B cannot retrofit quietly.)

**Fence.** Every routed call carries the lease's `epoch`. Revocation increments the
epoch in the host's lease table *first*; any in-flight or queued call bearing the old
epoch is refused by the router. This is ordinary lease fencing, and it exists because
"revoked" must mean "nothing further executes", not "nothing further is initiated".

**Revoke.** Three ways, all reaching the same epoch bump: the owner's word ("收回"), the
task closing (leases are task-scoped; the task ending is the lease ending), and expiry.
Revocation also detaches the routing immediately — the agent's next browser action lands
in the team box's logged-out browser and fails honestly.

### 3.4 Origin binding, enforced below the model

A lease names origins, and the identity box enforces them **in the network path, not in
the prompt**: an egress proxy inside the identity container refuses connections to
non-leased origins for the browser process. The model is told the rule, but the rule
does not depend on the model.

Prior art to evaluate before building any of this: OpenAI Codex's `codex-rs/
network-proxy` (policy routing, managed MITM CA, socket blocking) — DimAgent's Linux
sandbox ships a direct fork of it, which is evidence the component is liftable. The
choice between forking that and a narrower CDP-level navigation gate is an open question
for review (§7), with one constraint fixed either way: **enforcement sits below anything
the model or the page can claim.** That is the answer to the review's "无可信填充事件"
finding — there is no trusted fill event, so nothing may be designed that needs one.
Stage A avoids credential filling entirely (takeover login); a credential injector with
per-fill, origin-bound approval (the Browserbase-style shape) is explicitly Stage C,
and inherits this constraint.

### 3.5 Files cross the boundary task-scoped, host-mediated

Work products made under a lease (an exported report, a downloaded statement) reach the
team where the task lives: the host copies named files from the identity box's downloads
directory into the task conversation's inbox on the team box — the same exchange
convention chats already use. Every transfer is logged with `{taskId, principal, files}`.
There is no shared volume and no "sync"; a copy is an auditable event, a mount is not.

### 3.6 `login_private`: the fail-closed no-capture state

The review's exact words: 停录 ≠ 停截图. Pausing ffmpeg while three other paths keep
capturing is a red light wired to one bulb.

The state is **one flag in the identity box's boxd, checked at the service layer** — the
single choke point every capture path already flows through. While set:

- record-service refuses to be running (an active recording is stopped, with a marked
  gap in the timeline: "登录段,未录制");
- the computer service's screenshot action — including the screenshot attached to every
  computer action result — returns a marked refusal frame, not pixels;
- browser-service CDP captures (snapshot screenshots) return the same refusal;
- clipboard reads refuse (a password travels through clipboards).

**Enumeration guard, mechanical:** a test enumerates every capture call site in the boxd
source (the same technique as the usage ledger's MODEL_CALLS guard — by enclosing
declaration, not by proximity) and fails when a site appears that does not consult the
flag. A new capture path added in a later month must fail this test until it handles
`login_private`. Fail-closed is a property of the test, not of anyone's memory.

**Visible, not administrative:** while the state is set, the chat card and the web page
both show 停录中·登录窗口, and the recording timeline afterwards shows the gap. The
third product review's condition, kept: the red light is for the user to see, not a
backend policy.

Entered when the owner starts a takeover login (web button; Stage A) and left when they
end it. Never entered or left by the agent.

### 3.7 Profile integrity: snapshots, because the read-only bit is not COW

The review is right that a read-only mount is not protection: legitimate use *writes*
the profile constantly (session refresh, cookie rotation), so the profile cannot be
read-only during a lease, and once writable, a misbehaving session can corrupt it.

Design: **snapshot on lease start** — a cheap copy of the profile volume (tar in Stage
A; overlayfs/btrfs later if size demands) retained for N days. The snapshot is a
rollback point the owner can restore ("回到上周三登录后的状态"), and doubles as the
forensic artifact when a lease is suspected of having done something to the profile.
The lease works on the live profile, not the snapshot — login state that legitimately
refreshed during honest work should persist.

### 3.8 Backup, archive, and deletion

Today's upgrade archive includes browser sessions — with identity boxes, that archive
would quietly become a bundle of everyone's logins. Closed as follows:

- **Identity volumes are excluded from every plain archive** (upgrade, backup, export).
  Stage A ships this exclusion the same week the first identity box exists.
- Encrypted backup of identity volumes is Stage C. Until then the honest recovery from
  loss is re-login, and the design says so rather than promising a backup it does not
  encrypt.
- **注销** (the owner leaving, or wanting out): destroy container, volume and snapshots;
  write a receipt in the audit log naming what was destroyed and when. Deletion is a
  first-class operation with a test, not a `docker rm` someone remembers.

### 3.9 What this costs to run

One container per principal-with-logins, idle-stopped (started on lease, stopped after
expiry + grace). Spend attribution needs nothing new: leased work already bills to the
requesting principal via `usage.principal`. The "钱包" idea from the product plan
(per-principal budget for identity use) is out of scope for this document beyond noting
it attaches naturally to the lease grant point.

## 4. Interaction

### 4.1 Login (Stage A)

From the web UI: the owner opens their identity box page, presses 登录, gets the noVNC
view of the identity display with the red 停录中 banner, logs into the site with their
own hands, presses 完成. No chat-side login flow in Stage A — a login is rare, deliberate
and worth a real screen.

### 4.2 Using it

The person asks for work as always. When the task needs a leased origin (the agent hits
a login wall, or the request names a site the owner has state for), the agent asks; the
approval card goes to the identity owner and names the task, the origins and the expiry.
On grant, the agent's browser actions for those origins execute in the identity box; the
task card shows 用了 <owner> 的登录 as a line, because auditability includes the chat.

### 4.3 What the agent knows

The agent is told: the lease's origins, that actions on them route elsewhere, and that
the login window is not visible to it. It is *not* told cookies, tokens, or anything
recoverable into secret text — there is nothing shaped like a secret in its context, so
there is nothing for a prompt injection on a leased page to exfiltrate from context. (A
leased page can still see whatever a logged-in browser session shows it; that is what
origin-scoping and the owner's grant are consenting to, and the card says so.)

## 5. Build order

**Stage A — single principal (the current installation):**

1. Identity box image: narrowed boxd (no shell/fs/job services), browser, display.
2. Provisioner + registry: create/start/stop/destroy, principal → container.
3. `login_private` in boxd with the capture-site enumeration guard test; red banner in
   web; recording gap marker.
4. Takeover login flow in the web UI (§4.1).
5. Lease table on the host (grant / epoch / revoke / expiry) + router: computer and
   browser tool calls carry a target box resolved per-call from the lease. Approval
   delivery targeted at the owner (== requester today, wired as owner).
6. Task-scoped file egress (§3.5).
7. Migration: browser login state out of the team box's `.config` volume; team box
   becomes login-free; archives exclude identity volumes. This is the step after which
   "重建即干净" is finally true, and it gets a test that greps a fresh archive for
   cookie stores.

**Stage B — multiple principals:** owner ≠ requester approval routing exercised for
real, per-origin lease UX in chat, revocation verbs, snapshot retention policy, egress
origin enforcement (proxy or CDP gate, per the review's answer to §7).

**Stage C — explicitly deferred:** credential injector with per-fill approval, encrypted
identity backup, wallet/budgets, DingTalk parity.

No calendar estimate in this document. After review, Stage A is estimated step by step
against the code that exists, per the process that replaced the discredited "两周半".

## 6. Acceptance conditions (carried from review, with their tests)

1. **停录 ≠ 停截图.** `login_private` closes *every* capture path — computer-action
   screenshots, host-requested screenshots, CDP captures, recording, clipboard reads —
   and the enumeration guard test fails on any capture site that does not consult the
   flag. Verified by the guard test plus one integration test per path asserting the
   marked refusal.
2. **只读位 ≠ COW.** Profile protection is snapshot-based (§3.7); a lease start without
   a snapshot is an error, tested.
3. **无可信填充事件.** No component trusts a page- or model-originated claim about where
   credentials went. Stage A contains no credential filling at all; the Stage C injector
   design must re-pass review against this condition.
4. **Fencing is real.** A revoked lease's in-flight call is refused: test drives a slow
   call, revokes mid-flight, asserts refusal by epoch.
5. **The team box route is absent, not forbidden.** From inside the team box there is no
   network path to an identity box; tested from the box, not from the host.
6. **Targeted delivery.** A lease approval reaches the identity owner's chat identity
   even when someone else asked for the work; tested with two principals.
7. **Archives are clean.** A fresh upgrade/backup archive contains no identity volume
   content; tested by grep for known cookie-store paths.

## 7. Open questions for the review

- Egress enforcement: fork `codex-rs/network-proxy` (heavier, proven, MITM-capable) or
  a CDP-level navigation/request gate (lighter, browser-only, no CA management)? The
  identity box only runs a browser, which argues for the lighter gate — what does the
  gate miss that the proxy catches? (Non-browser processes are absent by construction;
  is that absence load-bearing enough?)
- Downloads: browser downloads inside the identity box are the one legitimate file
  producer; is a downloads-directory sweep enough, or does §3.5 need content limits?
- Multiple identities per principal (work + personal accounts on one site): one box with
  browser profiles per identity, or one box per identity? Leases name origins today;
  do they need to name profiles?
- Clipboard during non-login lease use: the team agent cannot read the identity box's
  clipboard today (narrowed boxd keeps clipboard for the *owner's* login session). Does
  any workflow need it, and at what cost?
- The R33 class of failure (input grabs) applies to the identity display too;
  `close_window` shipped for the team box — the identity box inherits it, but who is
  allowed to drive it there, given the owner may be mid-login?
