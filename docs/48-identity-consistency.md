# 48 · One person across channels

*2026-09-09. Making a person's DingTalk, Feishu and web identities resolve to one person, so
authority and approvals follow the human and not the door. Extends docs/22 (domain model, the
Principal + identity-link design) and docs/09 (tenancy); it does not replace them.*

## What already exists (docs/22, `principals.ts`, `identity.ts`)

- A **Principal** is a person. It carries several **identity links**, each a
  `<channelId>:<vendor subject>` string with the channel **incarnation** it was bound under —
  `feishu:ou_a`, `dingtalk:xxx`, `telegram:123`, `web:…`.
- **One identity, one person** is enforced; identity uniqueness is
  `(channelId, incarnation, vendorSubject)`.
- **Authority is per-principal**, not per-door: `principals.roleOf(identity)` resolves the
  identity to its principal and returns that person's role. Spend, task requester and audit all
  key on `principal.id`.
- **Standing/session approvals are box-subject** (docs/22 §3) and migrate with a bind, so a grant
  a person gave through one channel already applies when the same person acts through another —
  *once the identities are one principal*.

So the target behaviour — "@ from Feishu, approve from web, spend attributed to one person" — is
the designed behaviour. The problem is entirely in **how two channel identities become one
principal**, and how accurately.

## The gap

1. **Vendor subject is per-app, not shared.** The same human is `feishu:ou_a` under one Feishu
   app and `feishu-zongheng:ou_b` under another, and `dingtalk:xxx` on DingTalk. There is no
   shared key across vendors, so nothing can merge them automatically today.
2. **Linking is manual.** An admin types the identity strings onto one principal in the settings
   roster, or the knock/bind flow links them one at a time. There is no zero-touch path and no
   self-service path.
3. **The one accurate cross-vendor key is missing from the model.** docs/22 keys on vendor
   subject; it never records a directory anchor (work email, org unionid) — which is the only
   thing that is *the same value* for one human across DingTalk and Feishu inside an org.

## The design

### 1. The accurate key: a verified org anchor

The canonical person key stays `Principal.id` (opaque, stable). The **merge key** is a
**verified enterprise anchor** — work email first, else the org's unionid/mobile — resolved from
the door's own contact API (`dingtalk-contact`, `lark-contact`) the first time an identity is
seen. The Principal gains an `anchors` set (`email:alice@corp.com`, `dingtalk-union:…`).

Never merge on: a vendor open_id across vendors (not shared), a display name (ambiguous), or a
value the person can type unverified. Anchors are **tenant-scoped**: `email:alice@corpA` is not
the same person as an identical string in another tenant.

### 2. Merge policy

- **Auto-link on a matching verified anchor, within one tenant.** New identity resolves to
  `email:alice@corp` and a principal already holds that anchor → link it, no action. This is the
  zero-touch case and the best UX: the person @s from Feishu today and from DingTalk tomorrow and
  it just works.
- **Conflict is surfaced, not merged.** Two principals holding the same anchor, or an anchor that
  resolves to a different existing person, stops and asks an admin — the same "one identity, one
  person" guard, one level up.
- **No directory anchor → explicit claim.** Personal accounts with no org email fall back to an
  authenticated claim (below).

### 3. The link UX, in order of how good it feels

1. **Zero-touch (directory anchor).** Nothing to do; the anchor does it.
2. **Self-service claim.** A person signed into the web through one channel sees "这是我的另一个账号
   (Link another account)", runs the second channel's OAuth, and the proven identity is linked to
   their principal. Authenticated, never typed. This is the missing self-service path and the main
   UX win to build.
3. **Admin roster.** The current manual surface, kept as override and audit.

### 4. Approvals and consistency, once merged

- An approval or question is addressed to the **person (principal)**, delivered to the channel the
  request came through so they see it where they are; the same person can answer from the web or
  any other linked channel, because authority is per-principal. This already holds — merging is
  what makes it correct across channels.
- **Standing grants already flow per-principal/box-subject**, so a pre-authorised action class
  (the "auto-approve" a person wanted) resolves regardless of which channel the next request
  arrives on — no re-ask. Optional refinement: a per-principal standing grant keyed on an action
  *class* rather than one fingerprint, for "always let this person's requests through for agent A".
- **Consistency guards** are the ones docs/22 already names: incarnation retires a re-provisioned
  channel's links; the knock/bind CAS linearises relinking; an unknown identity is its own viewer
  principal (fail-safe); the docs/22 §7 namespace migration is the prerequisite before any
  incarnation is ever bumped.

## Data keys, stated once

| Thing | Key | Never |
|---|---|---|
| A person | `Principal.id` (opaque, stable) | — |
| Merge two identities | verified org anchor (`email:` / `union:`), tenant-scoped | vendor open_id across vendors; display name; unverified input |
| An identity link | `(channelId, incarnation, vendorSubject)` | keying on the door's display name |
| Who may answer an approval | the `Principal.id` the answering identity resolves to | the raw channel identity |
| Spend / requester / audit | `Principal.id` | the channel identity |

## What to build (tracked in Involute under the identity milestone)

1. Resolve and store a **verified anchor** per identity via the door contact APIs.
2. **Auto-link** on matching anchor within a tenant; surface conflicts to an admin.
3. **Self-service "link another account"** OAuth claim on the web.
4. **Per-principal standing grant** for an action class (the true "auto-approve").
5. The docs/22 §7 **namespace/incarnation migration** as the prerequisite for cross-tenant safety.

## Not done / risks

- Anchors depend on the door having contact-read scope; without it, fall back to explicit claim.
- Cross-tenant is the dangerous direction: an anchor must never merge two people across tenants —
  the tenant scope on the anchor is load-bearing and must be tested.
- Bumping incarnation before the §7 migration is the reviewed failure (a new tenant's colliding
  subject inheriting an old principal's role); it stays frozen until that migration exists.
