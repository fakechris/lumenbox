# External browsers and desktop control

These are box execution capabilities, not an application workflow engine. They do
not define accounts, jobs, retry policy, result acceptance, or when an external
application should recover. A standalone installation needs no external service,
configuration, heartbeat, or registration. Its built-in browser and desktop lease
path remains the default.

## Authority and caller responsibilities

All routes below require the existing box administrator bearer token. An operation
projection is not a replacement for that token. These are installation-administrator
APIs, not mutually isolated tenant APIs. Applications should call their own trusted
adapter, which authenticates the caller and sends only authorized operations to the
box. Do not distribute the administrator credential to untrusted workers.

The administrator coordinates display allocation across *all* applications and local
agents, supplies reachable CDP addresses, and owns monotonically increasing epochs.
A browser's `browserInstanceId` is opaque; `generation` and `endpointEpoch` describe
its incarnation. The box never queries a particular application database or starts
an external process to resolve uncertainty. Separate administrators must not assign
conflicting resources on the same box.

## Attachment and execution

- `POST /browser/endpoint` attaches an external CDP browser to one display. Replaying
  the same complete binding preserves the session. A newer incarnation invalidates
  old pages even when it reuses the same network address. Older epochs receive 409.
- `POST /browser/endpoint/unregister` conditionally removes the named instance. It
  retains the identity floor; an old delayed registration cannot resurrect it.
- `POST /displays/ensure` and `/displays/control` can carry `epoch` and `op_token` to
  arm the desktop execution fence. Subsequent operations must carry that projection
  in addition to existing authentication/ownership checks.
- `POST /displays/guard/revoke` takes `from_epoch` and a stable `revoke_id`. Revocation
  is durable and idempotent, including when it arrives before the first arm. A later
  legitimate controller must use a newer epoch.

Control epochs and endpoint epochs are different: one orders execution authority,
the other browser attachment. Neither constitutes application success. The box does
not issue external claims or refresh application grants. Shell and file tools can
invoke an external adapter without adding routing state to the host task board.

Execution rechecks authority after waits and before native input/capture launches.
A process already launched cannot be recalled. Callers must bound operations and
reject obsolete results; this is not a promise of instantaneous cancellation.

## Restart, corruption and failure

Read `GET /browser/endpoint/reconcile-token` using administrator authentication after
a daemon restart. Replaying a current snapshot with that boot's `reconcile_token`
restores a known desktop. The token proves knowledge of this boot, not permission:
administrator authentication is still mandatory. An old queued message must not
be decorated with a new boot token without checking its source of truth.

On restart, managed resources retain identity floors but have no usable live
connection until reconciled. Unmanaged resources remain local. Corrupt authority
files fail closed because missing entries cannot safely be classified as unmanaged.
Per-display repair is durable and leaves unnamed resources unknown across restarts.

`scope_complete: true` is a **box-wide administrator assertion**, never a claim that
one application's list is complete. Only after inventorying every external owner
may the administrator make this assertion alongside the current boot token. If the
complete inventory is unavailable, leave partial recovery in place. The box cannot
infer completeness from a heartbeat or an individual service's available resources.
No automatic repair deadline or retry schedule is imposed on a standalone user.

Persistence failures return errors without publishing an uncommitted authority
transition. Endpoint loss never falls back to a different local browser. Termination
and retry of an external application belong to its caller.

## Deployment and independent callers

An externally provisioned box can be attached through the existing `box attach`
command. Container mounts, X socket sharing and external process networking belong
to that provisioner's deployment configuration. No application-specific container
volume option is required in LumenBox.

The hermetic endpoint, display-ownership, external-browser-recovery and X11 authority
tests use independent fake controllers and renderer addresses. They require neither
external credentials nor a running application. Ordinary unregistered desktop tests
continue to exercise the existing local path.
