import { personalBoxUsesQuota, type PersonalBoxes } from "../host/personal-boxes.ts";
import { roleAtLeast, type Principal, type Principals } from "../host/principals.ts";
import { personalBoxesOf } from "../host/box-quota.ts";
import type { apiError } from "./api-error.ts";

interface Deps {
  boxes: PersonalBoxes;
  principals: Principals;
  identity: string | undefined;
  quota(owner: string): number | undefined;
  authorize(owner: string): boolean;
  connections(): ReadonlyArray<{ id: string; connected: boolean; detail?: string }> | undefined;
  residents(id: string): { id: string; name: string }[];
  reconnect(id: string): Promise<void>;
  read(): Promise<Record<string, unknown>>;
  send(status: number, body: unknown): void;
  error: typeof apiError;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : "Personal computer operation failed.";

function confirmIds(confirmed: unknown, current: string[], message: string) {
  if (!Array.isArray(confirmed) || confirmed.length !== current.length || new Set(confirmed).size !== current.length ||
    !current.every(id => confirmed.includes(id))) throw new Error(message);
}

const changedAgents = "The agents on these computers changed. Review them and confirm again.";
const changedComputers = "The member’s computers changed. Review them and confirm again.";

export async function personalBoxRoute(route: string, deps: Deps): Promise<void> {
  const { boxes, principals, identity, quota, residents, read, send, error } = deps;
  principals.reload();
  const admin = () => identity === undefined || (principals.isKnown(identity) && principals.roleOf(identity) === "admin");
  const counts = (owner: string, entries = boxes.quotaEntries()) => ({ quota: quota(owner) ?? null, held: personalBoxesOf(entries, owner).length });
  const agentInfo = (id: string) => {
    const agents = residents(id);
    return { agents: agents.map(agent => agent.name), agentIds: agents.map(agent => agent.id) };
  };
  const listed = async (owner?: string) => {
    const rows = await boxes.listWithPodStatus(owner);
    const connections = deps.connections();
    return rows.map(row => {
      const connection = connections?.find(box => box.id === row.id);
      const unreachable = connections !== undefined && row.status === "ready" && !connection?.connected;
      return { ...row, ...(unreachable ? { status: "unreachable" as const, connectionError: connection?.detail } : {}), ...agentInfo(row.id) };
    });
  };
  type Rows = Awaited<ReturnType<typeof listed>>;
  const current = (person: Principal, rows: Rows) => ({
    boxes: rows, ...counts(person.id), canCreate: deps.authorize(person.id), name: person.name,
  });
  const inventory = (rows: Rows) => {
    const entries = boxes.quotaEntries();
    const people = principals.list().map(person => ({ id: person.id, name: person.name, eligible: deps.authorize(person.id), ...counts(person.id, entries) }));
    return { people, boxes: rows.map(box => {
      const person = people.find(row => row.id === box.owner);
      return { ...box, ownerName: person?.name ?? box.ownerName ?? box.owner, orphaned: !person || box.retained };
    }) };
  };
  try {
    if (route === "GET /api/personal-boxes/panel") {
      if (principals.installation().mode !== "organisation") { send(200, {}); return; }
      const person = identity && principals.isKnown(identity) ? principals.resolve(identity) : null;
      const team = admin() ? await listed() : null;
      const mine = person && current(person, team ? team.filter(row => row.owner === person.id && !row.retained) : await listed(person.id));
      send(200, { mine, inventory: team && inventory(team) });
      return;
    }
    if (["GET /api/personal-boxes/admin", "POST /api/personal-boxes/admin", "GET /api/personal-boxes/admin-cleanup", "POST /api/personal-boxes/admin-cleanup"].includes(route)) {
      if (!admin()) { send(403, error("cleanup-admin-only")); return; }
      if (route === "GET /api/personal-boxes/admin") { send(200, inventory(await listed())); return; }
      if (route === "GET /api/personal-boxes/admin-cleanup") { send(200, { boxes: boxes.cleanupList() }); return; }
      const body = await read();
      principals.reload();
      if (!admin()) { send(403, error("cleanup-admin-only")); return; }
      if (typeof body.id !== "string") { send(400, error("cleanup-needs-choice")); return; }
      if (route === "POST /api/personal-boxes/admin-cleanup") {
        if (typeof body.deleteData !== "boolean" || Object.keys(body).some(key => !["id", "deleteData"].includes(key))) {
          send(400, error("cleanup-needs-choice")); return;
        }
        try { await boxes.cleanup(body.id, body.deleteData); }
        catch { send(409, error("cleanup-failed")); return; }
        send(200, { boxes: boxes.cleanupList() });
        return;
      }
      const box = boxes.inventory().find(row => row.id === body.id);
      if (!box) { send(404, error("personal-box-not-found")); return; }
      if (body.action === "transfer" && typeof body.recipient === "string") {
        const recipient = principals.byId(body.recipient);
        if (!recipient || recipient.id !== body.recipient) throw new Error("The recipient is not on the team.");
        boxes.transfer(box.id, recipient.id, recipient.name);
      } else if (body.action === "recover") {
        if (!principals.byId(box.owner) && !box.pendingRemoval) throw new Error("Assign this computer to a team member first.");
        const result = await boxes.retry(box.owner, box.id, undefined, true);
        if (result.status === "ready") {
          await deps.reconnect(box.id);
          const connections = box.status === "ready" ? deps.connections() : undefined;
          const connection = connections?.find(row => row.id === box.id);
          if (connections && !connection?.connected) throw new Error(connection?.detail || "Personal computer is unreachable.");
        } else if (result.error) throw new Error(result.error);
      } else if (body.action === "keep" || body.action === "delete") {
        if (body.action === "delete") confirmIds(body.agentIds, agentInfo(box.id).agentIds, changedAgents);
        const result = await boxes.remove(box.owner, box.id, body.action === "delete", { deleteAgents: body.deleteAgents === true });
        if (result.error) throw new Error(result.error);
      } else { send(400, error("cleanup-needs-choice")); return; }
      send(200, { ok: true });
      return;
    }

    if (!identity || !principals.isKnown(identity)) { send(403, error("personal-box-sign-in")); return; }
    if (route === "GET /api/personal-boxes") {
      const person = principals.resolve(identity);
      send(200, current(person, await listed(person.id))); return;
    }
    const action = route.startsWith("POST /api/personal-boxes/") ? route.split("/").at(-1) : undefined;
    const fields = action === "create" ? ["requestId", "name"] : action === "rename" ? ["id", "name"] :
      action === "remove" ? ["id", "deleteData", "deleteAgents", "agentIds"] : action === "retry" ? ["id"] : undefined;
    if (!fields) { send(404, error("personal-box-action-unknown")); return; }
    const body = await read();
    principals.reload();
    const person = principals.resolve(identity);
    const stillAuthorized = () => { principals.reload(); return principals.hasCurrentIdentity(person.id, identity) && roleAtLeast(principals.roleOf(identity), "driver"); };
    if (!principals.isKnown(identity) || ((action !== "remove" || (body.deleteData === true && body.deleteAgents === true)) && !stillAuthorized())) {
      send(403, error("personal-box-revoked")); return;
    }
    if (Object.keys(body).some(key => !fields.includes(key)) ||
      (action === "create" ? typeof body.requestId !== "string" : typeof body.id !== "string") ||
      (action === "remove" && (typeof body.deleteData !== "boolean" || (body.deleteAgents !== undefined && typeof body.deleteAgents !== "boolean"))) ||
      (action === "rename" && typeof body.name !== "string") || (body.name !== undefined && typeof body.name !== "string")) {
      send(400, error("personal-box-params")); return;
    }
    if (action === "rename") {
      boxes.rename(person.id, body.id as string, body.name as string);
      send(200, current(person, await listed(person.id))); return;
    }
    // Only the caller's own computers, for every removal: a computer kept when its owner was removed is not on their
    // list any more, and is the admin's to dispose of even if they come back (INV-2099).
    if (action === "remove" && !boxes.list(person.id).some(box => box.id === body.id)) { send(404, error("personal-box-not-found")); return; }
    if (action === "remove" && body.deleteData === true && (body.deleteAgents === true || body.agentIds !== undefined)) {
      confirmIds(body.agentIds, agentInfo(body.id as string).agentIds, changedAgents);
    }
    const result = action === "create"
      ? await boxes.create(person.id, body.requestId as string, stillAuthorized, {
        ...(typeof body.name === "string" ? { name: body.name } : {}), ownerName: person.name,
      })
      : action === "retry" ? await boxes.retry(person.id, body.id as string, stillAuthorized)
        : await boxes.remove(person.id, body.id as string, body.deleteData as boolean,
          typeof body.deleteAgents === "boolean" ? { deleteAgents: body.deleteAgents } : undefined);
    if (result.status === "ready") await deps.reconnect(result.id);
    const view = current(person, await listed(person.id));
    if (action === "create" && body.name === undefined) {
      // Older clients use the minimal provisioning response.
      const summaries = view.boxes.map(({ id, name, status, error, stateReason, dataRetained, podStatus, connectionError }) =>
        ({ id, name, status, error, stateReason, dataRetained, podStatus, connectionError }));
      send(200, { ...view, boxes: summaries, boxId: result.id });
    } else send(200, { ...view, boxId: result.id });
  } catch (failure) { send(409, { error: errorText(failure) }); }
}

export function planBoxDispositions(
  boxes: PersonalBoxes, owner: Principal, roster: Principal[], disposition: unknown,
  quota: Deps["quota"], authorize: Deps["authorize"], checkResidents: (ids: string[], deleting: boolean) => void,
  residents: Deps["residents"],
): () => Promise<void> {
  const rows = boxes.list(owner.id), ids = rows.map(box => box.id);
  const choice = disposition && typeof disposition === "object" && !Array.isArray(disposition)
    ? disposition as { action?: unknown; recipient?: unknown; boxIds?: unknown; agentIds?: unknown } : undefined;
  if (choice) confirmIds(choice.boxIds, ids, changedComputers);
  if (!choice || (choice.action !== "keep" && choice.action !== "transfer" && choice.action !== "delete")) {
    if (rows.length || disposition !== undefined) throw new Error("Choose what to do with the member’s personal computers before removing them.");
    return async () => {};
  }
  if (!rows.length) return async () => {};
  boxes.checkMemberRemoval(owner.id);
  let apply: (id: string) => Promise<void>;
  if (choice.action === "transfer") {
    const recipient = roster.find(person => person.id === choice.recipient && roleAtLeast(person.role, "driver") && person.identities.length > 0);
    if (!recipient || !authorize(recipient.id)) throw new Error("Choose an eligible team member for the transfer.");
    const needed = rows.filter(box => personalBoxUsesQuota(box.status)).length;
    const limit = quota(recipient.id);
    if (needed && limit !== undefined && personalBoxesOf(boxes.quotaEntries(), recipient.id).length + needed > limit)
      throw new Error("The recipient has no personal box quota available.");
    apply = async id => { boxes.transfer(id, recipient.id, recipient.name); };
  } else {
    const deleteData = choice.action === "delete";
    if (deleteData) confirmIds(choice.agentIds, ids.flatMap(id => residents(id).map(agent => agent.id)), changedAgents);
    checkResidents(ids, deleteData);
    apply = async id => {
      const result = await boxes.remove(owner.id, id, deleteData, { ownerName: owner.name, deleteAgents: deleteData });
      if (result.error) throw new Error(result.error);
    };
  }
  return async () => {
    const results = await Promise.allSettled(ids.map(apply));
    if (results.some(result => result.status === "rejected"))
      throw new Error("The member was removed, but some computers still need attention in Computers.");
  };
}
