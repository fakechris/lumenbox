# Control plane

Design for the multi-user system: many people, each with a box allocated on demand. Written
before it is built, and marked where it cannot be verified here — there is no cluster, no second
user and no domain in this environment, so anything about scheduling is a design claim rather
than a measured one.

## 1. What the control plane is for, and what it must stay out of

The box already contains the agent runtime. Turn scheduling, agent messaging, tool dispatch and
the transcript all happen inside it ([03-architecture.md](03-architecture.md) §3.2). That is the
property this whole design rests on:

> **The control plane is never in the path of a turn.**

It allocates boxes, authenticates people, meters usage, and takes boxes away. A running turn does
not touch it, so it can be restarted, upgraded, or briefly broken without stopping work that is
already happening. Anything that would put it in the turn path — proxying tool calls, holding
conversation state, brokering agent messages — is out of scope by design, not by omission.

Consequence to accept: while the control plane is down, nobody can get a *new* box, and metering
falls behind. Both are recoverable. A turn dying mid-flight because a scheduler restarted is not.

## 2. The one fact that shapes the rest

**The box never initiates outbound contact.** Verified: `boxd` only listens, and the only
outbound connection anything in the box makes is the orchestrator's call to the model API (and
the egress proxy, when configured). There is no registration, no heartbeat, no phone-home.

So:

- **The broker remembers what it created.** Allocation state lives in the control plane, not
  discovered from the fleet. A box cannot tell anyone who it belongs to, and giving it the ability
  to would mean giving it an identity and an outbound channel — a new attack surface for the one
  container we deliberately do not trust.
- **Everything is pulled.** Health, crash records and usage are read from the box by a collector.
  Nothing is pushed.
- **A box is inert without its record.** Losing the control plane's state orphans boxes: they keep
  running and serving whoever holds their tokens, and nothing knows whose they are. That makes the
  allocation store the one piece of state that must be durable and backed up (§6).

## 3. Components

Each is listed with what a placeholder means, because the point of naming all of them now is that
the seams exist before the implementations do.

| Component | Job | Placeholder version |
| --- | --- | --- |
| **Gateway** | Authenticate a person; route them to their box's UI over TLS | Single shared password, direct redirect, no TLS |
| **Allocator** | Create, find, stop and destroy boxes for a tenant | `compose`: one container per tenant on this host |
| **Store** | Tenants, boxes, tokens, quotas, usage | SQLite file behind a repository interface |
| **Credentials** | Issue box, UI and owner tokens; hold provider keys | Generate and store; keys still passed as env |
| **Model relay** | Give a box a scoped endpoint instead of the real provider key | Absent: the key goes in the box, as today |
| **Collector** | Pull health, crashes and usage from every box | Poll loop writing to the store |
| **Metering** | Turn usage into per-tenant totals and enforce budgets | Totals only, no enforcement |
| **Reaper** | Stop idle boxes, enforce quotas, clean up volumes | Idle timeout only |

The order they become real: Store → Allocator → Gateway → Collector → Metering → Relay → Reaper.
The Relay is last of the substantial ones and it is the one that changes the security posture; see
§7.

## 4. Allocation

### 4.1 The interface

The existing `BoxProvisioner` answers "where is *the* box". A fleet needs one level up:

```ts
interface BoxAllocator {
  readonly kind: "compose" | "kubernetes" | "static";
  allocate(tenant: TenantId, spec: BoxSpec): Promise<BoxHandle>;   // idempotent per tenant
  find(tenant: TenantId): Promise<BoxHandle | undefined>;
  stop(handle: BoxHandle): Promise<void>;                          // keeps volumes
  destroy(handle: BoxHandle): Promise<void>;                        // volumes too
  list(): Promise<BoxHandle[]>;                                     // for reconciliation
}

interface BoxHandle {
  tenant: TenantId;
  id: string;                 // container name or pod name
  boxdUrl: string;            // as reachable from the control plane
  uiUrl: string;              // as reachable from the gateway
  tokens: { box: string; ui: string };
  createdAt: string;
  state: "starting" | "ready" | "stopped" | "gone";
}
```

`allocate` is idempotent per tenant: asking twice returns the same box. That is what makes a
retried request after a timeout safe, and it is the property most likely to be got wrong.

### 4.2 Implementations

**`compose` — first, and enough for a long time.** One container per tenant on one host, named
`agentbox-<tenant>`, with per-tenant volumes `agentbox-<tenant>-work|config|hostd`. Allocation is
`docker run` with the tenant's tokens; `find` is `docker inspect`; the UI port is published on
loopback and the gateway proxies to it. Limits: one host, no scheduling, no rolling upgrade.
Adequate for tens of boxes and for every part of the design that is not scheduling.

**`kubernetes` — later.** A box becomes a Pod plus a Service; `boxdUrl` is
`http://box-<tenant>.<ns>.svc:1337`, so the published-port problem disappears. Volumes become
PVCs. Node placement, quotas and admission become the cluster's job. **Unverified here.**

**`static` — for development.** One box, named by URL, the `attached` provisioner promoted to the
fleet interface. This is what lets the control plane run against a box on a laptop.

### 4.3 What a box needs told at creation

The control plane hands a box its identity by environment, because it has no other way to receive
it: `BOXD_TOKEN`, `AGENTBOX_UI_TOKEN`, the provider configuration, and — when the relay exists —
the relay address and a per-box token instead of a provider key. Nothing else. In particular the
box is not told the tenant's name; it does not need it and it should not be able to log it.

## 5. Identity and routing

```
person → gateway ──── session cookie ────► gateway looks up tenant → box handle
                └──── proxy /* ───────────► box UI (with its UI token injected)
```

- The gateway authenticates and holds the session. The box's UI token is never seen by the browser;
  the gateway injects it, the way the web server already injects the box token when proxying a
  desktop.
- One box per tenant, not per agent. Agents share a box and are isolated inside it by desktop and
  by owner token, which is already how it works.
- A tenant is the unit of everything: box, volumes, quota, usage, and eventually network policy.
  Users within a tenant are a later refinement; the schema has the column from the start (§6).

Authentication itself is deliberately unspecified — OIDC, a password list, or an existing
identity provider all fit behind the same seam. What matters is that it produces a tenant id
before anything else runs.

## 6. Store

The first place in this system where a real database is the right answer: the questions are
relational and the writes are concurrent.

```sql
tenant(id, name, created_at, state, quota_json)
box(id, tenant_id, allocator_kind, external_id, boxd_url, ui_url, state,
    created_at, last_seen_at, image)
box_token(box_id, kind, value_enc, created_at)         -- kind: box | ui
usage(id, tenant_id, box_id, agent_id, at, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
health(box_id, at, ok, degraded, components_json, crashes_json)
audit(id, tenant_id, actor, action, target, at, detail_json)
```

Decisions:

- **SQLite first, behind a repository interface.** One process, one file, no server to operate. The
  interface exists so Postgres is a second implementation rather than a rewrite — the same move
  that made the box provisioner replaceable.
- **`usage` is append-only and never aggregated in place.** Totals are queries. A metering bug then
  loses a report, not the history.
- **Tokens are stored encrypted at rest**, with the key from the environment. Not because the store
  is exposed, but because a database backup should not be a credential dump.
- **`audit` from the start.** Who allocated, stopped or destroyed what. A control plane without one
  cannot answer the first question asked after an incident.
- **`quota_json` and `components_json` are JSON on purpose.** Their shape will change; a migration
  per experiment is worse than a column that holds a document.

## 7. Credentials

Three exist today and become issued rather than generated locally: the box token, the UI token,
and per-agent desktop owner tokens (which stay inside the box, since the box is what checks them).

The fourth is the interesting one. **Today the provider key lives in the box**, which means an
agent with a shell can read it ([06-deployment.md](06-deployment.md) §9). For a multi-user system
that is not acceptable: it is not the operator's key at risk, it is every tenant's.

**The relay is the answer, and it is small.** The box is configured with a relay URL and a per-box
token; the relay holds the real provider key, checks the token, forwards the request, and records
usage on the way through. Then:

- No provider key ever enters a box.
- Revoking a box's access is deleting one row.
- Usage becomes exact and unforgeable, because it is measured where the request passes rather than
  reported by the thing being billed.

That last point matters enough to change the plan: **once the relay exists, metering should read
from it, not from the box.** Until then, usage is pulled from the box and is only as trustworthy as
the box.

## 8. Collector

A poll loop, because the box does not push (§2).

- Every N seconds per box: `GET /health` (already carries `desktop_health` and `crashes`) and a
  usage endpoint the box will grow as part of R-03.
- Writes `health` rows and appends `usage` rows.
- Marks a box `unreachable` after repeated failures, which is the signal the Reaper and the gateway
  both use — the gateway to tell a person their box is being restarted rather than showing a broken
  page.
- Usage must be pulled with a cursor, not a snapshot: the box keeps an append-only record and the
  collector remembers its offset, so a collector that was down for an hour catches up instead of
  losing an hour.

## 9. Failure model

| Failure | Effect | Recovery |
| --- | --- | --- |
| Control plane down | No new boxes; metering falls behind; existing work continues | Restart; collector catches up by cursor |
| Store lost | Boxes orphaned: running, serving whoever holds their tokens, owned by nobody | Backup; reconcile from `allocator.list()` and re-adopt by name |
| Box unreachable | That tenant cannot work | Reaper restarts it; volumes preserve their data |
| Box destroyed with volumes | That tenant's work is gone | Explicit action only, audited |
| Relay down | No agent can call a model; boxes idle | Restart; nothing lost |
| Gateway down | Nobody can reach their box | Restart; boxes keep running |

The pattern is the same one the box already follows: restart the smallest thing, never recycle a
container to recover a process, and make the loud failure the default.

## 10. Deployment shapes

**Development.** Control plane on a laptop, `static` allocator, one box. No gateway; the UI is
reached directly. This is what exists today plus a store.

**Single node.** Control plane and boxes on one host, `compose` allocator, gateway terminating TLS
and proxying. Tens of tenants. Everything in this document except cluster scheduling is exercised
here, which is why it comes first.

**Cluster.** `kubernetes` allocator; boxes are pods with PVCs; the gateway is an ingress; the store
is Postgres. Unverified here.

## 11. What changes in the box

Deliberately little, which is the test of whether the seams were drawn in the right places:

1. **A usage record the collector can pull with a cursor** (R-03). New.
2. **A health check that covers the orchestrator, not just boxd** (R-02). New.
3. **Provider configuration that can point at a relay** instead of holding a key. The provider
   layer already takes a base URL and an auth style, so this is configuration, not code.
4. **Nothing else.** No tenant awareness, no registration, no outbound identity.

If implementing the control plane requires more than this list, the seams were wrong and the box
should change before the control plane does.

## 12. Order of work

1. R-01, R-02, R-03, R-07 in the box — the last two define what the control plane consumes.
2. Store and `static` allocator: the control plane running against a laptop box.
3. `compose` allocator and gateway: the first real multi-user system, on one host.
4. Collector and metering.
5. Relay, and metering moves behind it.
6. Reaper, quotas.
7. `kubernetes` allocator, when there is a cluster to verify it against.
