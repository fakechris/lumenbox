<!-- doc: 107-organisation-sign-in
     title: Signing in to an organisation with DingTalk: activation by an Admin, a box on first sign-in
     family: decision
     status: current
     updated: 2026-11-27
-->
# Signing in to an organisation with DingTalk: activation by an Admin, a box on first sign-in

An organisation runs LumenBox on its own Kubernetes (docs/95 §3). Its people are in a DingTalk
organisation. They should scan a code, be let in if an Admin has said so, and find their own box
waiting. Decided with Chris on 2026-11-27; not built yet.

## 1. What exists and what does not (0.4.9)

| Need | Today |
|---|---|
| Server on the organisation's cluster, a box per person as a pod | Exists (`deploy/kubernetes/`, personal boxes, INV-1692) |
| Roles | Exist: Admin, driver, viewer, and box membership inside that (docs/22) |
| The desktop app as a client of the organisation | Exists (docs/95 §4) |
| Sign in on the web with the organisation's chat account | **Feishu only.** DingTalk can chat but cannot sign in (INV-729) |
| The organisation's departments and people | Synced from Feishu or DingTalk, used only for box quotas. A directory row never makes a person here |
| Letting a person in | A person asks from a chat ("knock") and an Admin approves, or redeems an invite code. No bulk way |
| The person's box | The person presses *Create your personal box* |

## 2. Decisions

1. **DingTalk signs in on the web the same way Feishu does.** One sign-in path per door type
   behind one dispatcher; the state check, the expiry and the safe return address are shared.
   Only members of the DingTalk organisation the door's app belongs to can complete it.
2. **Admission stays by request.** Scanning proves who somebody is; it does not let them in. A
   person the Admins have not activated sees "your request is with the Admins" and appears in
   the Admin's list as *asked to join*. Nobody is admitted because the directory lists them.
3. **An Admin activates, one person or a whole department.** In Settings → Team → People the
   Admin sees the directory as a department tree with each person's state, and can:
   - sync the directory now (it also refreshes daily);
   - activate a person, choosing the role;
   - activate a department: everyone in it now, optionally with its sub-departments, with one
     role for all. It is done once, for the people listed at that moment. Somebody who joins the
     department later is *listed*, and asks or is activated like anyone else.
4. **A box on first sign-in.** When an activated person with the driver role or above signs in
   and has no personal box, one is created for them within their quota, without a button. The
   page shows it being prepared, and why if it fails. A viewer gets none. An Admin can turn this
   off for the installation.
5. **Leaving the organisation ends the sign-in.** When a sync no longer lists an activated
   person, their sessions and tokens are revoked and they become *left*. Their box and its data
   are kept and shown to the Admins, who decide; nothing is deleted by a sync.

## 3. A person's states

| State | How they got there | Can sign in | Has a box |
|---|---|---|---|
| listed | In the synced directory | No | No |
| asked to join | Scanned, not activated | No — sees the waiting page | No |
| active | Activated by an Admin (alone or with a department), or the first Admin by the bootstrap code | Yes | Created on first sign-in if a driver or above |
| left | Was active; the directory no longer lists them, or an Admin removed them | No | Kept for the Admins to decide |

## 4. What must hold

- **Activation is a record, not a row.** It names the directory source and the person's subject
  in it, the role, who activated and when, and whether it came from a department. It becomes a
  person on the roster only when that subject signs in and DingTalk vouches for it. So the rule
  that a directory row never creates a person still stands: an Admin's act plus an authenticated
  sign-in does.
- **One identity across chat and web.** The person who signs in on the web is the same roster
  person their DingTalk chat messages belong to. The sign-in identity and the directory's
  identity are not the same string at the vendor; the mapping is made at sign-in through the
  vendor's own lookup and is the first thing to verify against a real DingTalk organisation.
- **A sync only ends what the directory started.** *Left* by sync applies to a person whose
  activation names that directory source. The first Admin (bootstrap code) and anyone admitted by
  an invite code or a chat request are not in that set: a sync never signs them out, and they can
  be linked to their directory row later by signing in with DingTalk. A sync never removes the
  last Admin either: if the only Admin is no longer listed, they stay and the page says so.
- **A changed door is a different source.** The directory source already carries the door's
  incarnation and tenant; an activation made against one does not apply to another.
- **Bulk acts are audited as bulk acts**: who, which department, how many people, which role.
- **Quota still decides.** A box is created automatically only where the person's quota (person,
  department, installation — the existing order) allows one. Out of quota is said on the page
  and shown to the Admins; it is not an error to retry.
- **Sign-in is limited** per address and per account (docs/106 R4), and an unactivated person's
  repeated scans make one request, not many.

## 5. What an Admin needs on the cluster (the deployment side)

| Item | State |
|---|---|
| See every member's box: owner, state, image version, age, quota used; restart and delete from the page | INV-2042, committed, not fixed |
| Sessions survive a server restart or rollout | INV-2045, committed, not fixed |
| HTTPS in front, and the server refusing an organisation start without it (docs/106 R1, R2) | Not built; the guide says to add an Ingress |
| One replica, a short stop on upgrade: said in the guide, with the pre-pull step and a backup and restore procedure for the state volume | Guide exists for the control plane; to be written for the organisation server |
| An acceptance run of the organisation stories with DingTalk in place of Feishu | Not run; 0.4.7's run used Feishu |
| The desktop app joining an organisation on an internal address with the organisation's own certificate | Not verified |

## 6. Not decided here

- Shared storage for an organisation (files every member's agent can reach): a design of its own.
- WeCom sign-in: joins the same dispatcher when its door exists.
- Automatic activation of new department members: declined for now (decision 2).
