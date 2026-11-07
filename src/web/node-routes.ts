/**
 * An organisation's nodes (INV-1697, docs/96 §4): machines the organisation owns, each running its
 * boxes for the organisation. Three routes, all an Admin's, all only on an organisation:
 *
 *   - `POST /api/nodes/enrol` — the app on the node machine calls it with the session an Admin just
 *     got by signing in to the organisation there (Feishu or DingTalk, through `/login`; INV-1701).
 *     The organisation issues the node credential in the reply, once. Nobody types or copies a
 *     code: the sign-in is the proof. A non-Admin's session is refused, and so is the installation's
 *     own credential, which names nobody and so could not say who enrolled the machine.
 *   - `GET /api/nodes` — every node, its boxes, whether each is connected, and when the node was
 *     last heard (its registrations repeat as a heartbeat; box-register-routes.ts).
 *   - `POST /api/nodes/revoke` — cuts the node off: every box on it is revoked as one box is
 *     (`POST /api/boxes/revoke`), and its credential is refused from then on.
 *
 * Also here, because it is a node rule: a node's native environment box opens to members only while
 * the box says its commands run under the OS sandbox (INV-1700, `confinement` in its health).
 */

import type { BoxEntry } from "../box/boxes.ts";
import type { ConnectCodeStore, Registration } from "../box/connect-codes.ts";
import { apiError } from "./api-error.ts";

type Reply = { status: number; body: unknown };

/** A node's name: what a person reads in the Boxes list, and the prefix of its boxes' names. */
export const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export interface NodeRouteDeps {
  readJson: () => Promise<Record<string, unknown>>;
  refusedAdmin: () => boolean;
  /** The signed-in person, or undefined for the installation's own credential. */
  person: () => string | undefined;
  installationMode: () => "single-machine" | "organisation";
  connectCodes: ConnectCodeStore;
  box: (id: string) => BoxEntry | undefined;
  connected: (id: string) => boolean;
  /** Cuts one box off, as `POST /api/boxes/revoke` does. */
  revokeBox: (id: string) => void;
  log: (line: string) => void;
}

/** One box of a node, as the organisation's Boxes list shows it: the box model's state and reason (INV-1692, INV-712). */
function nodeBoxView(registration: Registration, deps: Pick<NodeRouteDeps, "box" | "connected">) {
  const entry = deps.box(registration.boxId);
  const connected = entry !== undefined && deps.connected(entry.id);
  const state = registration.revoked !== undefined ? "revoked" : connected ? "connected" : "offline";
  return {
    id: registration.boxId,
    name: registration.name,
    kind: entry?.kind === "host" ? "native" : "docker",
    state,
    ...(state === "revoked" ? { stateReason: "NodeRevoked" } : state === "offline" ? { stateReason: "NotAnswering" } : {}),
    members: entry?.members ?? [],
    lastSeenAt: registration.lastSeenAt,
  };
}

export async function nodeRoute(route: string, deps: NodeRouteDeps): Promise<Reply | undefined> {
  if (!route.startsWith("GET /api/nodes") && !route.startsWith("POST /api/nodes")) return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: null };
  if (deps.installationMode() !== "organisation") return { status: 409, body: apiError("nodes-personal") };
  const { connectCodes, log } = deps;
  if (route === "GET /api/nodes") {
    return { status: 200, body: { nodes: connectCodes.listNodes().map(({ boxes, ...node }) => ({ ...node, boxes: boxes.map(registration => nodeBoxView(registration, deps)) })) } };
  }
  const body = await deps.readJson();
  if (route === "POST /api/nodes/enrol") {
    const person = deps.person();
    if (person === undefined) return { status: 403, body: apiError("node-enrol-person-needed") };
    const name = String(body.name ?? "").trim();
    if (!NODE_NAME.test(name)) return { status: 400, body: apiError("node-name-invalid") };
    const enrolled = connectCodes.enrolNode({ name, by: person });
    if (!enrolled.ok) return { status: 409, body: apiError("node-name-revoked", { name }) };
    log(`nodes: ${name} (${enrolled.node.id}) enrolled by ${person}`);
    return { status: 200, body: { node: enrolled.node, credential: enrolled.credential } };
  }
  if (route === "POST /api/nodes/revoke") {
    const which = String(body.node ?? "");
    const boxes = connectCodes.revokeNode(which, deps.person() ?? "operator");
    if (boxes === undefined) return { status: 404, body: apiError("node-named-unknown", { node: which }) };
    for (const id of boxes) deps.revokeBox(id);
    log(`nodes: ${which} revoked by ${deps.person() ?? "operator"}; ${boxes.length} box(es) cut off`);
    return { status: 200, body: { revoked: which, boxes } };
  }
  return undefined;
}

/** What `GET /api/boxes` adds to a node's box: which node it is on. */
export function nodeOfBox(connectCodes: ConnectCodeStore, boxId: string): { node: { id: string; name: string } } | Record<string, never> {
  const nodeId = connectCodes.registrationOf(boxId)?.nodeId;
  const node = nodeId === undefined ? undefined : connectCodes.listNodes().find(candidate => candidate.id === nodeId);
  return node === undefined ? {} : { node: { id: node.id, name: node.name } };
}

/**
 * Whether members may be set on this box now: a node's native environment opens to anybody only
 * while its health says commands run under the OS sandbox. Answers the refusal, or undefined.
 */
export async function nodeMembersRefusal(
  connectCodes: ConnectCodeStore,
  entry: BoxEntry,
  members: "everyone" | string[],
  confinement: () => Promise<{ active: boolean; reason?: string } | undefined>
): Promise<Reply | undefined> {
  if (entry.kind !== "host" || connectCodes.registrationOf(entry.id)?.nodeId === undefined) return undefined;
  if (Array.isArray(members) && members.length === 0) return undefined;
  const state = await confinement().catch(() => undefined);
  if (state?.active === true) return undefined;
  return { status: 409, body: apiError("node-native-unconfined", { box: entry.name, reason: state?.reason ?? "the box is not answering" }) };
}
