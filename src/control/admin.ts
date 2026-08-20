/**
 * The tenant's own administration: members, roles, and the box's life.
 *
 * On the control plane rather than in the box, because these are questions about *tenancy* and the
 * box deliberately has no concept of a tenant — it knows an opaque user id and a role, and teaching
 * it more would undo the separation that keeps the control plane out of the path of a turn
 * ([../docs/09-tenancy.md](../docs/09-tenancy.md) §4, §6).
 *
 * Three decisions, each because the alternative fails quietly:
 *
 *   - **Owner-only, checked in one place.** `requireOwner` runs before the route table is consulted,
 *     not inside each handler, because a check per handler is how one handler ends up without one.
 *   - **Every mutation writes an audit row before it acts**, including the ones that then fail.
 *     "Who tried" is asked after an incident as often as "who did", and a log written on success
 *     cannot answer the first.
 *   - **The audit feed is paginated by sequence, not by time.** A reader that remembers a timestamp
 *     either double-counts or skips depending on which way its clock is wrong — the same reasoning
 *     as the usage log ([../docs/05-data.md](../docs/05-data.md) §2.4).
 *
 * Deliberately no UI. An admin UI is worth building when there is more than one operator, and it
 * would be a second authorisation surface with its own session handling; building one before the
 * permission model has settled fixes the model into the shape of the UI. This is the seam it will
 * sit on.
 */


import type { BoxAllocator } from "./allocator.ts";
import { isRole, type ControlStore, type Role } from "./store.ts";
import type { Session } from "./gateway.ts";
import { meterTenants } from "./collector.ts";

export interface AdminDeps {
  store: ControlStore;
  allocator: BoxAllocator;
  /** Who is asking, already verified by the gateway's signed cookie. */
  session: Session;
  log?: (line: string) => void;
}

export type AdminRoute =
  | { kind: "tenant" }
  | { kind: "users" }
  | { kind: "invite" }
  | { kind: "set-role"; userId: string }
  | { kind: "remove-member"; userId: string }
  | { kind: "audit" }
  | { kind: "restart-box" }
  | { kind: "destroy-box" }
  | undefined;

/**
 * Matches an admin path, or undefined when it is not one.
 *
 * Separate from the handling so the surface can be read in one place, and so a path that looks
 * administrative but is not — `/api/admin/../state` — cannot be mistaken for one.
 */
export function adminRouteOf(method: string, pathname: string): AdminRoute {
  if (!pathname.startsWith("/api/admin/")) return undefined;
  const rest = pathname.slice("/api/admin/".length);
  if (rest.includes("..") || rest.includes("//")) return undefined;

  if (method === "GET" && rest === "tenant") return { kind: "tenant" };
  if (method === "GET" && rest === "users") return { kind: "users" };
  if (method === "POST" && rest === "users") return { kind: "invite" };
  if (method === "GET" && rest === "audit") return { kind: "audit" };
  if (method === "POST" && rest === "box/restart") return { kind: "restart-box" };
  if (method === "POST" && rest === "box/destroy") return { kind: "destroy-box" };

  const member = /^users\/([A-Za-z0-9-]+)$/.exec(rest);
  if (member !== null) {
    if (method === "PATCH") return { kind: "set-role", userId: member[1]! };
    if (method === "DELETE") return { kind: "remove-member", userId: member[1]! };
  }
  return undefined;
}

/** Whether the session may use this surface at all. Everything here is an owner's business. */
export function requireOwner(session: Session): string | undefined {
  return session.role === "owner"
    ? undefined
    : "Only an owner of this tenant can do that. Ask an owner to change your role, or to do it.";
}

export interface AdminResult {
  status: number;
  body: unknown;
}

/**
 * Answers one admin request.
 *
 * Returns a status and a body rather than writing to the response, so every route is testable
 * without a socket and so the auditing cannot be skipped by an early `res.end()`.
 */
export async function handleAdmin(
  route: NonNullable<AdminRoute>,
  body: Record<string, unknown>,
  query: URLSearchParams,
  deps: AdminDeps
): Promise<AdminResult> {
  const { store, allocator, session } = deps;
  const log = deps.log ?? (() => {});

  const refusal = requireOwner(session);
  if (refusal !== undefined) {
    // Audited too: an attempt to use an owner's surface is worth knowing about, and this is the row
    // that says who tried.
    store.audit({
      tenantId: session.tenantId,
      actor: session.userId,
      action: `admin.refused.${route.kind}`,
      target: session.tenantId,
      detail: { role: session.role },
    });
    return { status: 403, body: { error: refusal } };
  }

  const tenant = store.getTenant(session.tenantId);
  if (tenant === undefined) return { status: 404, body: { error: "No such tenant." } };

  /** One audit row, written before the thing it describes is attempted. */
  const audit = (action: string, target: string, detail?: unknown) => {
    store.audit({ tenantId: tenant.id, actor: session.userId, action, target, detail });
  };

  switch (route.kind) {
    case "tenant": {
      const box = store.boxForTenant(tenant.id);
      const meter = meterTenants(store).find(entry => entry.tenantId === tenant.id);
      return {
        status: 200,
        body: {
          tenant: { id: tenant.id, name: tenant.name, state: tenant.state, quota: tenant.quota },
          box:
            box === undefined
              ? null
              : {
                  id: box.id,
                  externalId: box.externalId,
                  state: box.state,
                  image: box.image,
                  createdAt: box.createdAt,
                  lastSeenAt: box.lastSeenAt ?? null,
                  // Not the tokens. This surface is for a person, and a token on a page is a token
                  // in a screenshot.
                },
          health: box === undefined ? null : store.latestHealth(box.id),
          usage: meter ?? null,
        },
      };
    }

    case "users":
      return {
        status: 200,
        body: {
          members: store.membersOf(tenant.id).map(entry => ({
            userId: entry.userId,
            username: entry.username,
            role: entry.role,
            createdAt: entry.createdAt,
          })),
        },
      };

    case "invite": {
      const username = String(body.username ?? "").trim();
      const role = String(body.role ?? "member");
      if (username === "") return { status: 400, body: { error: "A username is required." } };
      if (!isRole(role)) {
        return { status: 400, body: { error: `Unknown role "${role}". Use owner, member or viewer.` } };
      }
      audit("admin.invite", username, { role });
      const user = store.upsertUser({ username });
      const membership = store.putMembership(user.id, tenant.id, role as Role);
      log(`${session.userId} added ${username} as ${role}`);
      // Honest about what this does and does not do: it grants a role. It does not create a
      // credential, because the identity provider owns those — a password list is configuration, and
      // OIDC has its own directory.
      return {
        status: 200,
        body: {
          userId: membership.userId,
          username: membership.username,
          role: membership.role,
          note: "Role granted. This does not create a sign-in credential; the identity provider owns those.",
        },
      };
    }

    case "set-role": {
      const role = String(body.role ?? "");
      if (!isRole(role)) {
        return { status: 400, body: { error: `Unknown role "${role}". Use owner, member or viewer.` } };
      }
      const existing = store.membership(route.userId, tenant.id);
      if (existing === undefined) {
        return { status: 404, body: { error: "That person is not in this tenant." } };
      }
      // The one rule that prevents a tenant nobody can administer. Checked before the write, and
      // stated in the message so it does not read as an arbitrary refusal.
      if (existing.role === "owner" && role !== "owner" && countOwners(store, tenant.id) === 1) {
        return {
          status: 409,
          body: {
            error:
              "That is the only owner. Make someone else an owner first, or this tenant would have " +
              "nobody who can manage it.",
          },
        };
      }
      audit("admin.set-role", existing.username, { from: existing.role, to: role });
      store.putMembership(route.userId, tenant.id, role as Role);
      // A role change takes effect at the person's next sign-in, because the role travels in their
      // session cookie. Said here rather than left to be discovered.
      return {
        status: 200,
        body: {
          userId: route.userId,
          role,
          note: "Takes effect at that person's next sign-in; suspend them to act immediately.",
        },
      };
    }

    case "remove-member": {
      const existing = store.membership(route.userId, tenant.id);
      if (existing === undefined) {
        return { status: 404, body: { error: "That person is not in this tenant." } };
      }
      if (existing.role === "owner" && countOwners(store, tenant.id) === 1) {
        return {
          status: 409,
          body: { error: "That is the only owner; the tenant would have nobody who can manage it." },
        };
      }
      audit("admin.remove-member", existing.username, { role: existing.role });
      store.removeMembership(route.userId, tenant.id);
      return { status: 200, body: { removed: route.userId } };
    }

    case "audit": {
      const limit = Math.min(Number(query.get("limit") ?? 100) || 100, 500);
      // Only this tenant's rows. An owner administers their own team, not the fleet.
      const rows = store
        .recentAudit(1_000)
        .filter(row => row.tenantId === tenant.id)
        .slice(0, limit);
      return { status: 200, body: { rows } };
    }

    case "restart-box": {
      const box = await allocator.find(tenant.id);
      if (box === undefined) return { status: 404, body: { error: "This tenant has no box." } };
      audit("admin.box.restart", box.externalId);
      // Restart, not recreate: the volumes are the tenant's work, and this is the reversible one.
      const restartable = allocator as BoxAllocator & { restart?: (handle: typeof box) => Promise<void> };
      if (typeof restartable.restart !== "function") {
        return {
          status: 501,
          body: { error: `The ${allocator.kind} allocator cannot restart a box.` },
        };
      }
      await restartable.restart(box);
      return { status: 200, body: { restarted: box.externalId } };
    }

    case "destroy-box": {
      // The one irreversible thing this system does, so it needs the tenant's own name typed. Not a
      // boolean: a confirm flag is something a script sets once and forgets, and this deletes the
      // work and the logged-in browser profiles.
      if (String(body.confirm ?? "") !== tenant.name) {
        return {
          status: 400,
          body: {
            error:
              `This destroys the box, everything the agents made, and what they logged into. ` +
              `Send {"confirm": "${tenant.name}"} to proceed.`,
          },
        };
      }
      const box = await allocator.find(tenant.id);
      if (box === undefined) return { status: 404, body: { error: "This tenant has no box." } };
      audit("admin.box.destroy", box.externalId, { volumesRemoved: true });
      await allocator.destroy(box);
      log(`${session.userId} destroyed ${box.externalId}`);
      return { status: 200, body: { destroyed: box.externalId } };
    }
  }
}

function countOwners(store: ControlStore, tenantId: string): number {
  return store.membersOf(tenantId).filter(entry => entry.role === "owner").length;
}
