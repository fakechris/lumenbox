/**
 * What the first screen is computed from (INV-2311, docs/112 §4): `GET /api/setup`, and which of the
 * boxes a person sees is theirs.
 *
 * Every person who may drive agents gets the same facts, so getting started is one list in both
 * editions: whether a model is set (a member's list says the Admin has not chosen one), and, per box
 * they may read, whether it is up, has an agent, and has done a piece of work. An Admin also learns
 * whether a chat channel is connected and whether the bootstrap code is still unredeemed.
 */
import type { BoxEntry } from "../box/boxes.ts";
import { personalBoxesOf } from "../host/box-quota.ts";
import type { AutoPersonalBoxView } from "../host/auto-personal-box.ts";

/** The edition a person reads: a personal installation (the desktop) or an organisation. */
export const editionOf = (mode: string | undefined): "personal" | "organisation" => (mode === "single-machine" ? "personal" : "organisation");

/**
 * The boxes that are this person's own: on the desktop the installation's box, the Owner's; on an
 * organisation the personal box whose one member they are (docs/112 §2, "your sandbox").
 */
export function yoursOf(entries: readonly BoxEntry[], person: string | undefined, mode: string | undefined, installationBox: string): Set<string> {
  if (editionOf(mode) === "personal") return new Set([installationBox]);
  return new Set(person === undefined ? [] : personalBoxesOf(entries, person).map(entry => entry.id));
}

export interface SetupDeps {
  role: "viewer" | "driver" | "admin";
  /** The caller's principal id; undefined for the token holder with no identity. */
  person: string | undefined;
  mode: string | undefined;
  installationBox: string;
  entries(): readonly BoxEntry[];
  boxes(): readonly { id: string; connected: boolean }[];
  mayReadBox(id: string): boolean;
  /** The agents this person may read, with the box each is in. */
  agents(): readonly { id: string; boxId: string }[];
  hasTranscript(agentId: string): boolean;
  /** Agents with a piece of work in review or done. */
  reviewed(): ReadonlySet<string>;
  modelConfigured(): Promise<boolean>;
  autoBox(person: string): AutoPersonalBoxView | undefined;
  door(): boolean;
  search(): boolean;
  /** The bootstrap code is unredeemed and the caller is the token holder. */
  bootstrapPending(): boolean;
}

/** `GET /api/setup`: undefined for any other route. */
export async function setupRoute(route: string, deps: SetupDeps): Promise<{ status: number; body: unknown } | undefined> {
  if (route !== "GET /api/setup") return undefined;
  const edition = editionOf(deps.mode), installationId = deps.installationBox;
  // A viewer drives nothing, so has nothing to start.
  if (deps.role === "viewer") return { status: 200, body: { installationId, edition } };
  const agents = deps.agents(), reviewed = deps.reviewed();
  const byBox = Object.fromEntries(deps.boxes().filter(box => deps.mayReadBox(box.id)).map(box => {
    const here = agents.filter(agent => agent.boxId === box.id);
    const agentTurn = here.some(agent => deps.hasTranscript(agent.id)), review = here.some(agent => reviewed.has(agent.id));
    return [box.id, { box: box.connected, agent: here.length > 0, agentTurn, review, established: agentTurn && review }];
  }));
  // On an organisation every person, the first Admin too, has a box of their own, made at first use (INV-2310).
  const own = deps.person !== undefined && edition === "organisation" ? personalBoxesOf(deps.entries(), deps.person).length > 0 : undefined;
  const admin = deps.role === "admin";
  return { status: 200, body: {
    installationId, edition, ...(admin ? byBox[installationId] : {}), byBox, key: await deps.modelConfigured(), hasPersonalBox: own,
    ...(deps.person !== undefined && own === false ? { autoBox: deps.autoBox(deps.person) } : {}),
    ...(admin ? { door: deps.door(), search: deps.search(), bootstrapPending: deps.bootstrapPending() } : {}),
  } };
}
