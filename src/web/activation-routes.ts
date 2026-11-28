/**
 * Letting people into an organisation by activation (INV-2202, INV-2220, docs/109): the directory an
 * Admin reads in Settings → Team → People as a department tree, activating a person or a department,
 * what happens at the door's sign-in, and what a sync does to somebody the directory stopped listing.
 *
 * Four things meet here and nowhere else:
 * - **the activation** (`activated`): the Admin's act makes the roster person at once, at the role
 *   chosen, holding the identity the door mints (`<door>:<subject>`, the same string the door's chat
 *   messages carry) — `enrolment.ts` — and asks for their personal box (`boxes`).
 * - **the sign-in** (`admit`): somebody the roster holds gets a session; it makes nobody. Anybody
 *   else has asked to join: one request, however many scans.
 * - **the sync** (`sync`): the same sync the quotas use, then *left* for everybody whose activation
 *   names this source and whom it no longer lists: the sign-in this directory gave them is taken
 *   off, and with it what was made from it. They stay on the roster as the owner of what they have,
 *   for the Admins to decide. Nothing is deleted. Somebody admitted another way has no activation
 *   here and is never touched, and the last Admin who can still sign in is never taken. A sync that
 *   would end many sign-ins at once is held, changing nothing, until an Admin confirms it.
 * - **the routes**: Admin only, organisation only. A department is expanded here against the
 *   snapshot of the moment, so what was done and what the audit says cannot differ.
 */

import { departmentScope, departmentTree, holdReason, type Activation, type Activations, activationRole, type DirectoryPersonState } from "../host/activations.ts";
import type { Directories, DirectorySnapshot, DirectorySource } from "../host/directory.ts";
import type { Principal, Principals, Role } from "../host/principals.ts";
import { enrol, type Enrolled } from "../host/enrolment.ts";
import type { DirectoryCredentials } from "../channels/directory-sources.ts";
import { apiError } from "./api-error.ts";
import type { Locale } from "../i18n/locale.ts";
import { tr } from "../i18n/messages.ts";

export interface AdmissionDeps {
  activations: Activations;
  directories: Directories;
  principals: Principals;
  credentials: (channelId: string) => DirectoryCredentials | undefined;
  fetch: typeof fetch;
  /** Every browser the person holds stops being served. */
  signOut: (principalId: string) => void;
  /** Every token of these ids (a person, a sign-in); `signInOnly`: only those made from that sign-in. */
  revokeTokens: (ids: readonly string[], signInOnly?: boolean) => void;
  log: (line: string) => void;
  /**
   * Personal boxes for people an activation made, where the installation makes them at activation
   * (auto-personal-box.ts): queued, a few starting at a time. Returns the ids it queued. Absent: none are made here.
   */
  boxes?: (people: readonly { id: string; name: string }[], channelId: string) => string[];
}

const PAGE = 50;

/** What somebody not on the roster is told in a direct message to the bot (INV-2221); undefined where the door's own knock answers. */
export function joinRequestWords(verdict: "asked" | "unlisted" | "no-directory" | undefined, locale: Locale): string | undefined {
  return verdict === "asked" ? tr("access.asked", locale) : verdict === "unlisted" ? tr("access.unlisted", locale) : undefined;
}
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
   * At the door's sign-in. `admitted`: the roster holds them — an Admin's activation made them, or
   * they were let in another way — and nobody is made here. `asked`: their request is with the
   * Admins. `refused`: this installation admits nobody this way (a personal installation, or a door
   * with no app behind it). The first sign-in on an activation is written down, once.
   */
  function admit(channelId: string, subject: string, name: string): "admitted" | "asked" | "refused" {
    principals.reload();
    const source = deps.credentials(channelId)?.source, identity = `${channelId}:${subject}`;
    if (principals.isKnown(identity)) {
      if (source !== undefined) activations.admitted(source, subject, principals.resolve(identity).id);
      return "admitted";
    }
    if (source === undefined || principals.installation().mode === "single-machine") return "refused";
    if (activations.request(source, { subject, name })) deps.log(`asked to join: ${identity} (${name}) signed in via ${channelId} and is not activated`);
    return "asked";
  }

  /**
   * Somebody not on the roster wrote to the door's bot (INV-2221, docs/109 §2 step c). `asked`: the
   * directory lists them, and their request is with the Admins — the request a sign-in makes, one
   * per person however often they write. `unlisted`: the directory does not list them, and nothing
   * is written. `no-directory`: there is no directory to ask — a door with no app credentials for
   * one, one never synced or whose app changed since, a single-machine installation — and the
   * door's own knock applies, as before.
   */
  function knocked(channelId: string, subject: string, name: string): "asked" | "unlisted" | "no-directory" {
    const source = deps.credentials(channelId)?.source, snapshot = source === undefined ? undefined : snapshotOf(source);
    if (source === undefined || snapshot === undefined || principals.installation().mode === "single-machine") return "no-directory";
    const row = snapshot.people.find(person => person.vendorSubject === subject);
    if (row === undefined) return "unlisted";
    if (activations.request(source, { subject, name: row.name })) deps.log(`asked to join: ${identityOf(source, subject)} (${row.name}, writing as ${name}) wrote to ${channelId} and is not activated`);
    return "asked";
  }

  /**
   * An Admin activates one person: somebody the directory lists, or somebody who asked — never a
   * subject typed from nowhere (undefined). The one path for it: the People page's press, and the
   * approval of a request that came from a chat.
   */
  function activatePerson(source: DirectorySource, subject: string, role: Role, by: string): { state: "active"; already: boolean } | undefined {
    const row = snapshotOf(source)?.people.find(person => person.vendorSubject === subject);
    const asked = activations.requests(source).find(request => request.subject === subject);
    if (row === undefined && asked === undefined) return undefined;
    const already = stateOf(source, subject) === "active";
    if (!already) {
      activations.activatePerson(source, { subject, name: row?.name ?? asked!.name }, role, by, row !== undefined);
      deps.log(`activated: ${identityOf(source, subject)} (${row?.name ?? asked!.name}) as ${role} by ${by}`);
      activated(source, by);
    }
    return { state: "active", already };
  }
  /**
   * Approving somebody who wrote to the bot, `<door>:<subject>`: an activation whenever this door's
   * directory can make one — they have a request waiting, or they knocked (`knocked`) and the
   * directory lists them. Undefined when it cannot, and the door's own knock decides instead.
   */
  function approveRequest(identity: string, role: Role, by: string, knocked = false): { state: "active"; already: boolean } | undefined {
    const at = identity.indexOf(":"), source = at <= 0 ? undefined : deps.credentials(identity.slice(0, at))?.source, subject = identity.slice(at + 1);
    if (source === undefined || principals.installation().mode === "single-machine") return undefined;
    const asked = activations.requests(source).some(request => request.subject === subject);
    const listed = knocked && snapshotOf(source)?.people.some(person => person.vendorSubject === subject) === true;
    return asked || listed ? activatePerson(source, subject, role, by) : undefined;
  }

  /**
   * After an activation was written to the ledger: the roster people it is owed are made, and their
   * boxes asked for. Also what a server start runs for every door (`catchUp`): it finishes an
   * activation a crash interrupted, and asks again for boxes a stopped server left queued. Never for
   * somebody home format 2 made from an older activation: nobody asked for a box when they were
   * activated, so they get theirs at their first use, as they would have.
   */
  function activated(source: DirectorySource, by: string, afterTheFact = false): Enrolled[] {
    const made = enrol(activations, principals, source, { log: deps.log, migrated: afterTheFact });
    for (const person of made) deps.log(`on the roster by activation: ${identityOf(source, person.subject)} is ${person.principalId}`);
    if (!afterTheFact) askBoxes(source, by, made.map(person => person.principalId));
    return made;
  }
  function askBoxes(source: DirectorySource, by: string, ids: readonly string[]): void {
    const people = ids.flatMap(id => { const person = principals.byId(id); return person !== undefined ? [{ id: person.id, name: person.name }] : []; });
    const queued = deps.boxes?.(people, source.channelId) ?? [];
    activations.boxesAsked(source, by, queued);
    if (queued.length > 0) deps.log(`personal boxes asked for ${queued.length} activated ${queued.length === 1 ? "person" : "people"} of ${source.channelId} by ${by}`);
  }
  function catchUp(channelIds: readonly string[]): void {
    if (principals.installation().mode === "single-machine") return;
    for (const channelId of channelIds) {
      const source = deps.credentials(channelId)?.source;
      if (source === undefined) continue;
      try {
        // Whoever a start makes is made after the fact, like the migration's people: this cannot tell an activation a crash interrupted from an older one.
        activated(source, "start", true);
        const standing = activations.activations(source).filter(activation => activation.leftAt === undefined && activation.migrated !== true
          && activation.principalId !== undefined && onRoster(source, activation.subject));
        askBoxes(source, "start", standing.map(activation => activation.principalId!));
      } catch (error) { deps.log(`activations of ${channelId} not caught up at start: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  /**
   * These people leave: each loses the sign-in this directory gave them, and nothing else. Somebody who
   * still holds another sign-in keeps their role and those sessions; a session is tied to the identity
   * it was made with, so the removed one stops being served without touching the rest, and only the
   * tokens made from that sign-in go. Somebody left with no sign-in at all becomes a viewer who still
   * owns their boxes: there every session and every token of theirs ends. The last Admin who can sign
   * in is never left without a way in: nobody would remain to let anybody back.
   */
  function leave(source: DirectorySource, leaving: readonly Activation[]): (Activation & { personId?: string })[] {
    principals.reload();
    let roster = principals.list();
    const gone: { activation: Activation; person?: Principal; kept: string[] }[] = [];
    for (const activation of leaving) {
      const identity = identityOf(source, activation.subject);
      const person = principals.isKnown(identity) ? roster.find(entry => entry.id === principals.resolve(identity).id) : undefined;
      const kept = person?.identities.filter(entry => entry !== identity) ?? [];
      if (person?.role === "admin" && kept.length === 0 && !roster.some(other => other.id !== person.id && other.role === "admin" && other.identities.length > 0)) {
        deps.log(`directory sync ${source.channelId}: ${person.name} is no longer listed and stays, being the only Admin`);
        continue;
      }
      if (person !== undefined) roster = roster.map(entry => entry.id !== person.id ? entry : kept.length > 0 ? { ...entry, identities: kept } : { ...entry, role: "viewer" as Role, identities: [] });
      gone.push({ activation, kept, ...(person !== undefined ? { person } : {}) });
    }
    if (gone.some(entry => entry.person !== undefined)) principals.save(roster);
    for (const { activation, person, kept } of gone) {
      const identity = identityOf(source, activation.subject);
      if (person !== undefined && kept.length > 0) deps.revokeTokens([identity], true);
      else if (person !== undefined) { deps.signOut(person.id); deps.revokeTokens([person.id, identity]); }
      deps.log(`left: ${identity} (${activation.name}) is no longer listed by ${source.channelId}; ${kept.length > 0 ? "that sign-in ended, their others stand" : "sign-ins and tokens ended"}, nothing deleted`);
    }
    return gone.map(({ activation, person }) => ({ ...activation, ...(person !== undefined ? { personId: person.id } : {}) }));
  }

  /**
   * After a sync: who the directory no longer lists, among the people it let in. A sync the brake does
   * not believe (`holdReason`) changes nothing and is held for an Admin; `listedBefore` is the head
   * count of the snapshot this one replaced.
   */
  function applySync(source: DirectorySource, listedBefore?: number): { left: number; held: number } {
    const snapshot = snapshotOf(source);
    if (snapshot === undefined) return { left: 0, held: 0 };
    const listed = new Set(snapshot.people.map(person => person.vendorSubject));
    const standing = activations.activations(source).filter(activation => activation.leftAt === undefined);
    activations.listed(source, standing.filter(activation => !activation.listed && listed.has(activation.subject)).map(activation => activation.subject));
    const leaving = standing.filter(activation => activation.listed && !listed.has(activation.subject));
    const reason = holdReason({ leaving: leaving.length, standing: standing.length, listedNow: snapshot.people.length, listedBefore });
    if (reason !== undefined) {
      activations.hold(source, reason, standing.length, leaving.map(({ subject, name }) => ({ subject, name })));
      deps.log(`directory sync ${source.channelId}: held (${reason}) — it no longer lists ${leaving.length} of ${standing.length} activated people; nothing was changed until an Admin confirms`);
      return { left: 0, held: leaving.length };
    }
    activations.dismissHold(source, "sync"); // a sync that is believed replaces one that was not
    const gone = leave(source, leaving);
    for (const person of gone) activations.left(source, { subject: person.subject, name: person.name }, person.personId);
    return { left: gone.length, held: 0 };
  }

  /** An Admin confirms a held sync: exactly the people it named leave, as one act. Undefined when nothing is held. */
  function confirmHeld(source: DirectorySource, by: string): { left: number } | undefined {
    const held = activations.held(source);
    if (held === undefined) return undefined;
    const named = new Set(held.people.map(person => person.subject));
    const gone = leave(source, activations.activations(source).filter(activation => activation.leftAt === undefined && named.has(activation.subject)));
    activations.leftConfirmed(source, by, gone.map(person => ({ subject: person.subject, name: person.name, ...(person.personId !== undefined ? { principalId: person.personId } : {}) })));
    deps.log(`held directory sync ${source.channelId} confirmed by ${by}: ${gone.length} left`);
    return { left: gone.length };
  }

  /** The directory sync, and what follows from it. Throws what `Directories.sync` throws: a failed fetch keeps the previous snapshot and nothing follows. */
  async function sync(channelId: string): Promise<{ left: number; held: number } | undefined> {
    const credentials = deps.credentials(channelId);
    if (credentials === undefined) return undefined;
    const before = snapshotOf(credentials.source)?.people.length;
    await directories.sync(credentials.source, () => credentials.provider.fetchDirectory({
      clientId: credentials.clientId, clientSecret: credentials.clientSecret, fetchFn: deps.fetch,
    }), () => deps.credentials(channelId)?.source);
    return applySync(credentials.source, before);
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

  return { admit, knocked, activatePerson, approveRequest, activated, catchUp, applySync, confirmHeld, sync, refreshStale, stateOf, snapshotOf, onRoster };
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

const ROUTES = [
  "GET /api/activations", "GET /api/activations/people", "GET /api/activations/audit", "POST /api/activations/person", "POST /api/activations/department", "POST /api/activations/dismiss",
  "POST /api/activations/held/confirm", "POST /api/activations/held/dismiss",
];

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
    if (chosen === undefined) return { status: 200, body: { ...base, channelId: null, departments: [], people: 0, requests: [], left: [], unlisted: [], held: null } };
    const { source } = chosen, snapshot = snapshotOf(source), listed = new Set(snapshot?.people.map(person => person.vendorSubject));
    const states = new Map(snapshot?.people.map(person => [person.vendorSubject, stateOf(source, person.vendorSubject)]));
    const counted = (ids: (person: DirectorySnapshot["people"][number]) => boolean, state: DirectoryPersonState) =>
      snapshot!.people.filter(person => ids(person) && states.get(person.vendorSubject) === state).length;
    const tree = snapshot === undefined ? [] : departmentTree(snapshot);
    const standing = activations.activations(source), held = activations.held(source), waiting = new Set(held?.people.map(person => person.subject));
    return {
      status: 200,
      body: {
        ...base, channelId: source.channelId, people: snapshot?.people.length ?? 0,
        // A sync that was not believed: who it would have signed out. Nothing changed; an Admin confirms or puts it away.
        held: held ?? null,
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
        // Active, once listed, not listed now, and not waiting in a held sync: the last Admin, whom a sync never takes.
        unlisted: snapshot === undefined ? [] : standing.filter(activation => activation.listed && !listed.has(activation.subject) && !waiting.has(activation.subject) && stateOf(source, activation.subject) === "active")
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
          const known = onRoster(source, person.vendorSubject), role = known ? principals.resolve(identityOf(source, person.vendorSubject)).role : state === "active" ? activation?.role : undefined;
          // "Activated, has not signed in yet" is read from the ledger's first sign-in, not from the roster: activation puts them there at once.
          const standing = activation !== undefined && activation.leftAt === undefined;
          return {
            subject: person.vendorSubject, name: person.name, ...(person.title !== undefined ? { title: person.title } : {}), state,
            ...(role !== undefined ? { role } : {}), signedIn: known && (!standing || activation.admittedAt !== undefined),
          };
        }),
      },
    };
  }

  if (route === "POST /api/activations/dismiss") {
    activations.dismiss(source, String(body.subject ?? ""), by);
    return { status: 200, body: { ok: true } };
  }

  if (route === "POST /api/activations/held/confirm") {
    const done = deps.admission.confirmHeld(source, by);
    return done === undefined ? { status: 404, body: apiError("directory-nothing-held") } : { status: 200, body: done };
  }
  if (route === "POST /api/activations/held/dismiss") {
    if (activations.dismissHold(source, by)) deps.log(`held directory sync ${source.channelId} put away by ${by}`);
    return { status: 200, body: { ok: true } };
  }

  const role = activationRole(body.role);
  if (role === undefined) return { status: 400, body: apiError("activation-role-invalid") };

  if (route === "POST /api/activations/person") {
    const done = deps.admission.activatePerson(source, String(body.subject ?? ""), role, by);
    return done === undefined ? { status: 404, body: apiError("directory-person-unknown") } : { status: 200, body: done };
  }

  // A department: everybody it lists now, once. Who joins it later is listed, and asks like anybody else.
  // Never as Admins: one press must not hand the settings to a whole department.
  if (role === "admin") return { status: 400, body: apiError("activation-department-admin") };
  if (snapshot === undefined) return { status: 409, body: apiError("directory-not-synced") };
  const department = String(body.department ?? ""), includeSub = body.includeSub === true;
  const done = activations.activateDepartment(source, snapshot, department, includeSub, role, by, subject => onRoster(source, subject));
  if (done === undefined) return { status: 404, body: apiError("directory-department-unknown") };
  deps.admission.activated(source, by);
  deps.log(`activated department ${department} of ${source.channelId}${includeSub ? " with its sub-departments" : ""}: ${done.activated} as ${role} by ${by}, ${done.alreadyActive} already active`);
  return { status: 200, body: done };
}
