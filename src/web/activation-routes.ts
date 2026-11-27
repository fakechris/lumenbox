/**
 * Letting people into an organisation by activation (INV-2202, docs/107): the directory an Admin
 * reads in Settings → Team → People as a department tree, activating a person or a department,
 * what happens at the door's sign-in, and what a sync does to somebody the directory stopped listing.
 *
 * Three things meet here and nowhere else:
 * - **the sign-in** (`admit`): an activation nobody has used yet becomes a person on the roster at
 *   the activation's role, linked to the identity the door mints (`<door>:<subject>`, the same string
 *   the door's chat messages carry). Anybody else has asked to join: one request, however many scans.
 * - **the sync** (`sync`): the same sync the quotas use, then *left* for everybody whose activation
 *   names this source and whom it no longer lists: every sign-in they hold is taken off, their
 *   sessions and tokens stop, and they stay on the roster as the owner of what they have, for the
 *   Admins to decide. Nothing is deleted. Somebody admitted another way has no activation here and is
 *   never touched, and the last Admin who can still sign in is never taken.
 * - **the routes**: Admin only, organisation only. A department is expanded here against the
 *   snapshot of the moment, so what was done and what the audit says cannot differ.
 */

import { departmentScope, departmentTree, type Activation, type Activations, activationRole, type DirectoryPersonState } from "../host/activations.ts";
import type { Directories, DirectorySnapshot, DirectorySource } from "../host/directory.ts";
import type { Principal, Principals, Role } from "../host/principals.ts";
import type { DirectoryCredentials } from "../channels/directory-sources.ts";
import { apiError } from "./api-error.ts";

export interface AdmissionDeps {
  activations: Activations;
  directories: Directories;
  principals: Principals;
  credentials: (channelId: string) => DirectoryCredentials | undefined;
  fetch: typeof fetch;
  /** Every browser the person holds stops being served. */
  signOut: (principalId: string) => void;
  /** Every token issued to the person, or to a sign-in they held. */
  revokeTokens: (ids: readonly string[]) => void;
  log: (line: string) => void;
}

const PAGE = 50;
const identityOf = (source: DirectorySource, subject: string) => `${source.channelId}:${subject}`;

export function admission(deps: AdmissionDeps) {
  const { activations, directories, principals } = deps;
  const snapshotOf = (source: DirectorySource): DirectorySnapshot | undefined => {
    const record = directories.of(source.channelId);
    return record !== undefined && directories.status(source) !== "changed" && directories.status(source) !== "not-synced" ? record.snapshot : undefined;
  };
  const onRoster = (source: DirectorySource, subject: string) => principals.isKnown(identityOf(source, subject));
  const stateOf = (source: DirectorySource, subject: string): DirectoryPersonState => activations.stateOf(source, subject, onRoster(source, subject));

  /**
   * At the door's sign-in, for an identity that is nobody's yet. `admitted`: the roster now holds
   * them. `asked`: their request is with the Admins. `refused`: this installation admits nobody this
   * way (a personal installation, or a door with no app behind it).
   */
  function admit(channelId: string, subject: string, name: string): "admitted" | "asked" | "refused" {
    principals.reload();
    const source = deps.credentials(channelId)?.source;
    if (source === undefined || principals.installation().mode === "single-machine") return "refused";
    const identity = identityOf(source, subject);
    const activation = activations.pending(source, subject);
    if (activation === undefined) {
      if (activations.request(source, { subject, name })) deps.log(`asked to join: ${identity} (${name}) signed in via ${channelId} and is not activated`);
      return "asked";
    }
    // Somebody who left and was activated again comes back as the person they were, with what they own.
    const roster = principals.list(), back = principals.byId(activation.principalId ?? identity);
    principals.save(back !== undefined
      ? roster.map(person => person.id === back.id ? { ...person, role: activation.role, identities: [...person.identities, identity] } : person)
      : [...roster, { id: identity, name: activation.name || name, role: activation.role, identities: [identity] }]);
    if (!principals.isKnown(identity)) return "asked";
    const person = principals.resolve(identity);
    activations.admitted(source, subject, person.id);
    deps.log(`activation used: ${identity} is ${person.name} (${person.id}) as ${activation.role}, activated by ${activation.by}`);
    return "admitted";
  }

  /** After a sync: who the directory no longer lists, among the people it let in. */
  function applySync(source: DirectorySource): { left: number } {
    const snapshot = snapshotOf(source);
    if (snapshot === undefined) return { left: 0 };
    principals.reload();
    const listed = new Set(snapshot.people.map(person => person.vendorSubject));
    const standing = activations.activations(source).filter(activation => activation.leftAt === undefined);
    activations.listed(source, standing.filter(activation => !activation.listed && listed.has(activation.subject)).map(activation => activation.subject));
    let roster = principals.list(), left = 0;
    const gone: { activation: Activation; person?: Principal }[] = [];
    for (const activation of standing) {
      if (listed.has(activation.subject) || !activation.listed) continue;
      const identity = identityOf(source, activation.subject);
      const person = principals.isKnown(identity) ? roster.find(entry => entry.id === principals.resolve(identity).id) : undefined;
      // Never the last Admin who can still sign in: nobody would be left to let anybody back.
      if (person?.role === "admin" && !roster.some(other => other.id !== person.id && other.role === "admin" && other.identities.length > 0)) {
        deps.log(`directory sync ${source.channelId}: ${person.name} is no longer listed and stays, being the only Admin`);
        continue;
      }
      // Left with no sign-in and no say; still the owner of their boxes, which the Admins decide about.
      if (person !== undefined) roster = roster.map(entry => entry.id === person.id ? { ...entry, role: "viewer" as Role, identities: [] } : entry);
      gone.push({ activation, ...(person !== undefined ? { person } : {}) });
    }
    if (gone.some(entry => entry.person !== undefined)) principals.save(roster);
    for (const { activation, person } of gone) {
      if (person !== undefined) { deps.signOut(person.id); deps.revokeTokens([person.id, ...person.identities]); }
      activations.left(source, { subject: activation.subject, name: activation.name }, person?.id);
      deps.log(`left: ${identityOf(source, activation.subject)} (${activation.name}) is no longer listed by ${source.channelId}; sign-ins and tokens revoked, nothing deleted`);
      left++;
    }
    return { left };
  }

  /** The directory sync, and what follows from it. Throws what `Directories.sync` throws. */
  async function sync(channelId: string): Promise<{ left: number } | undefined> {
    const credentials = deps.credentials(channelId);
    if (credentials === undefined) return undefined;
    await directories.sync(credentials.source, () => credentials.provider.fetchDirectory({
      clientId: credentials.clientId, clientSecret: credentials.clientSecret, fetchFn: deps.fetch,
    }), () => deps.credentials(channelId)?.source);
    return applySync(credentials.source);
  }

  /** The daily refresh: a directory somebody synced once is read again when it is a day old. */
  async function refreshStale(channelIds: readonly string[]): Promise<void> {
    if (principals.installation().mode === "single-machine") return;
    for (const channelId of channelIds) {
      const source = deps.credentials(channelId)?.source;
      if (source === undefined || directories.status(source) !== "stale") continue;
      try { await sync(channelId); deps.log(`directory ${channelId}: daily refresh done`); }
      catch (error) { deps.log(`directory ${channelId}: daily refresh failed (${error instanceof Error ? error.message : String(error)})`); }
    }
  }

  return { admit, applySync, sync, refreshStale, stateOf, snapshotOf, onRoster };
}

export interface ActivationRouteDeps extends AdmissionDeps {
  admission: ReturnType<typeof admission>;
  /** Answers 403 itself and returns true for anybody under Admin. */
  refusedAdmin: () => boolean;
  readJson: () => Promise<Record<string, unknown>>;
  /** Who is acting, for the record; the operator holding the installation's token has no id. */
  callerId: () => string | undefined;
  doors: () => readonly { id: string; name: string; type: string }[];
  boxesHeld: (principalId: string) => number;
}

type Reply = { status: number; body: unknown };

const ROUTES = ["GET /api/activations", "GET /api/activations/people", "GET /api/activations/audit", "POST /api/activations/person", "POST /api/activations/department", "POST /api/activations/dismiss"];

export async function activationRoute(route: string, query: URLSearchParams, deps: ActivationRouteDeps): Promise<Reply | undefined> {
  if (!ROUTES.includes(route)) return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: undefined };
  const { activations, directories, principals } = deps, { stateOf, snapshotOf, onRoster } = deps.admission;
  principals.requireOrganisation(); // activation admits a new person (INV-1689)
  const doors = deps.doors().flatMap(door => { const found = deps.credentials(door.id); return found ? [{ door, source: found.source }] : []; });

  if (route === "GET /api/activations/audit") return { status: 200, body: { acts: activations.audit() } };

  const reading = route.startsWith("GET ");
  const body = reading ? {} : await deps.readJson();
  if (!reading && deps.refusedAdmin()) return { status: 0, body: undefined };
  const wanted = reading ? query.get("channelId") : body.channelId;
  const chosen = doors.find(entry => entry.door.id === wanted) ?? (reading && (wanted === null || wanted === "") ? doors[0] : undefined);

  if (route === "GET /api/activations") {
    const base = {
      doors: doors.map(({ door, source }) => {
        const stored = directories.of(door.id);
        return { channelId: door.id, name: door.name || door.id, type: door.type, status: directories.status(source), syncedAt: stored?.syncedAt ?? null, failedAt: stored?.failedAt ?? null };
      }),
    };
    if (chosen === undefined) return { status: 200, body: { ...base, channelId: null, departments: [], people: 0, requests: [], left: [], unlisted: [] } };
    const { source } = chosen, snapshot = snapshotOf(source), listed = new Set(snapshot?.people.map(person => person.vendorSubject));
    const states = new Map(snapshot?.people.map(person => [person.vendorSubject, stateOf(source, person.vendorSubject)]));
    const counted = (ids: (person: DirectorySnapshot["people"][number]) => boolean, state: DirectoryPersonState) =>
      snapshot!.people.filter(person => ids(person) && states.get(person.vendorSubject) === state).length;
    const tree = snapshot === undefined ? [] : departmentTree(snapshot);
    const standing = activations.activations(source);
    return {
      status: 200,
      body: {
        ...base, channelId: source.channelId, people: snapshot?.people.length ?? 0,
        departments: tree.map(node => {
          const scope = departmentScope({ departments: tree, people: [] }, node.vendorId, true), inScope = (person: DirectorySnapshot["people"][number]) => person.departmentVendorIds.some(id => scope.has(id));
          return { ...node, active: counted(inScope, "active"), asked: counted(inScope, "asked"), left: counted(inScope, "left") };
        }),
        // Asked to join: the people who signed in and wait, whether or not the directory lists them.
        requests: activations.requests(source).filter(request => stateOf(source, request.subject) === "asked").map(request => ({ ...request, listed: listed.has(request.subject) })),
        left: standing.filter(activation => stateOf(source, activation.subject) === "left").map(activation => ({
          subject: activation.subject, name: activation.name, at: activation.leftAt ?? null, listed: listed.has(activation.subject),
          ...(activation.principalId !== undefined && principals.byId(activation.principalId) !== undefined ? { principalId: activation.principalId, boxes: deps.boxesHeld(activation.principalId) } : {}),
        })),
        // Active, once listed, not listed now: the last Admin, whom a sync never takes.
        unlisted: snapshot === undefined ? [] : standing.filter(activation => activation.listed && !listed.has(activation.subject) && stateOf(source, activation.subject) === "active")
          .map(activation => ({ subject: activation.subject, name: activation.name })),
      },
    };
  }

  if (chosen === undefined) return { status: 400, body: apiError("directory-channel-needed") };
  const { source } = chosen, snapshot = snapshotOf(source);
  const by = deps.callerId() ?? "operator";

  if (route === "GET /api/activations/people") {
    const department = query.get("department") ?? "", offset = Math.max(0, Number(query.get("offset")) || 0);
    const members = (snapshot?.people ?? []).filter(person => person.departmentVendorIds.includes(department)).sort((a, b) => a.name.localeCompare(b.name));
    return {
      status: 200,
      body: {
        total: members.length, offset,
        people: members.slice(offset, offset + PAGE).map(person => {
          const state = stateOf(source, person.vendorSubject), activation = activations.activation(source, person.vendorSubject);
          const role = onRoster(source, person.vendorSubject) ? principals.resolve(identityOf(source, person.vendorSubject)).role : state === "active" ? activation?.role : undefined;
          return {
            subject: person.vendorSubject, name: person.name, ...(person.title !== undefined ? { title: person.title } : {}), state,
            ...(role !== undefined ? { role } : {}), signedIn: onRoster(source, person.vendorSubject),
          };
        }),
      },
    };
  }

  if (route === "POST /api/activations/dismiss") {
    activations.dismiss(source, String(body.subject ?? ""), by);
    return { status: 200, body: { ok: true } };
  }

  const role = activationRole(body.role);
  if (role === undefined) return { status: 400, body: apiError("activation-role-invalid") };

  if (route === "POST /api/activations/person") {
    const subject = String(body.subject ?? "");
    const row = snapshot?.people.find(person => person.vendorSubject === subject);
    const asked = activations.requests(source).find(request => request.subject === subject);
    // Somebody the directory lists, or somebody who asked: never a subject typed from nowhere.
    if (row === undefined && asked === undefined) return { status: 404, body: apiError("directory-person-unknown") };
    const already = stateOf(source, subject) === "active";
    if (!already) {
      activations.activatePerson(source, { subject, name: row?.name ?? asked!.name }, role, by, row !== undefined);
      deps.log(`activated: ${identityOf(source, subject)} (${row?.name ?? asked!.name}) as ${role} by ${by}`);
    }
    return { status: 200, body: { state: "active", already } };
  }

  // A department: everybody it lists now, once. Who joins it later is listed, and asks like anybody else.
  if (snapshot === undefined) return { status: 409, body: apiError("directory-not-synced") };
  const department = String(body.department ?? ""), includeSub = body.includeSub === true;
  const done = activations.activateDepartment(source, snapshot, department, includeSub, role, by, subject => onRoster(source, subject));
  if (done === undefined) return { status: 404, body: apiError("directory-department-unknown") };
  deps.log(`activated department ${department} of ${source.channelId}${includeSub ? " with its sub-departments" : ""}: ${done.activated} as ${role} by ${by}, ${done.alreadyActive} already active`);
  return { status: 200, body: done };
}
