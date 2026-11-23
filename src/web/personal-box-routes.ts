import type { PersonalBoxes } from "../host/personal-boxes.ts";
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
  residents(id: string): string[];
  reconnect(id: string): Promise<void>;
  read(): Promise<Record<string, unknown>>;
  send(status: number, body: unknown): void;
  error: typeof apiError;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : "Personal computer operation failed.";

export async function personalBoxRoute(route: string, deps: Deps): Promise<void> {
  const { boxes, principals, identity, quota, residents, read, send, error } = deps;
  principals.reload();
  const admin = () => identity === undefined || (principals.isKnown(identity) && principals.roleOf(identity) === "admin");
  const counts = (owner: string, entries = boxes.quotaEntries()) => ({ quota: quota(owner) ?? null, held: personalBoxesOf(entries, owner).length });
  const listed = async (owner?: string) => {
    const rows = await boxes.listWithPodStatus(owner);
    const connections = deps.connections();
    return rows.map(row => {
      const connection = connections?.find(box => box.id === row.id);
      const unreachable = connections !== undefined && row.status === "ready" && !connection?.connected;
      return { ...row, ...(unreachable ? { status: "unreachable" as const, connectionError: connection?.detail } : {}), agents: residents(row.id) };
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
        if (result.status === "ready") await deps.reconnect(box.id);
        else if (result.error) throw new Error(result.error);
      } else if (body.action === "keep" || body.action === "delete") {
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
      action === "remove" ? ["id", "deleteData", "deleteAgents"] : action === "retry" ? ["id"] : undefined;
    if (!fields) { send(404, error("personal-box-action-unknown")); return; }
    const body = await read();
    principals.reload();
    const person = principals.resolve(identity);
    const stillAuthorized = () => { principals.reload(); return principals.hasCurrentIdentity(person.id, identity) && roleAtLeast(principals.roleOf(identity), "driver"); };
    if (!principals.isKnown(identity) || (action !== "remove" && !stillAuthorized())) { send(403, error("personal-box-revoked")); return; }
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
  boxes: PersonalBoxes, previous: Principal[], roster: Principal[], choices: unknown,
  quota: Deps["quota"], authorize: Deps["authorize"], checkResidents: (id: string, deleting: boolean) => void,
): () => Promise<void> {
  const removed = new Map(previous.filter(person => !roster.some(next => next.id === person.id)).map(person => [person.id, person]));
  const rows = boxes.inventory().filter(box => removed.has(box.owner) && !box.retained);
  if (!rows.length) return async () => {};
  if (!choices || typeof choices !== "object" || Array.isArray(choices))
    throw new Error("Choose what to do with the member’s personal computers before removing them.");
  const entries = boxes.quotaEntries(), assigned = new Map<string, number>();
  const ops = rows.map(box => {
    const choice = (choices as Record<string, { action?: unknown; recipient?: unknown }>)[box.owner];
    if (!choice || !["keep", "transfer", "delete"].includes(String(choice.action))) throw new Error("Choose what to do with the member’s personal computers.");
    if (box.status === "provisioning" || box.status === "deleting" || box.status === "interrupted") throw new Error("Finish the pending computer operation before removing this person.");
    const owner = removed.get(box.owner)!;
    if (choice.action === "transfer") {
      const recipient = roster.find(person => person.id === choice.recipient && roleAtLeast(person.role, "driver") && person.identities.length > 0);
      if (!recipient || !authorize(recipient.id)) throw new Error("Choose an eligible team member for the transfer.");
      const held = personalBoxesOf(entries, recipient.id).length + (assigned.get(recipient.id) ?? 0);
      const limit = quota(recipient.id);
      if (limit !== undefined && held >= limit) throw new Error("The recipient has no personal box quota available.");
      assigned.set(recipient.id, (assigned.get(recipient.id) ?? 0) + 1);
      return async () => { boxes.transfer(box.id, recipient.id, recipient.name); };
    }
    const deleteData = choice.action === "delete";
    checkResidents(box.id, deleteData);
    return async () => {
      const result = await boxes.remove(box.owner, box.id, deleteData, { ownerName: owner.name, deleteAgents: deleteData });
      if (result.error) throw new Error(result.error);
    };
  });
  return async () => {
    const results = await Promise.allSettled(ops.map(operation => operation()));
    if (results.some(result => result.status === "rejected"))
      throw new Error("The member was removed, but some computers still need attention in Computers.");
  };
}
