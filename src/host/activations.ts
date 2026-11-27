/**
 * Admission to an organisation by an Admin's activation (INV-2202, INV-2220, docs/109 §2–§3).
 *
 * Signing in through a door proves who somebody is; it does not let them in. An Admin activates a
 * person, or everybody a department lists at that moment, and **the Admin's act makes the person**:
 * the roster gains them at once (`enrolment.ts`), holding the identity the directory gives, so their
 * box can be made and the chat knows them before they have signed in anywhere. This ledger keeps
 * what the roster does not: the directory source, the person's subject in it, who activated and
 * when, the department it came from, that the roster person was made (`enrolled`) and that they
 * have since signed in (`admitted`). A directory row alone still makes nobody.
 *
 * `activations.jsonl` is append-only and never compacted: one line per act, which makes it the
 * audit too. A department activation is one line naming the department, how many people and which
 * role, never one line per person. State is the fold of the lines, keyed by the whole source
 * (door, incarnation, tenant), so an activation made against one door does not apply to its
 * replacement.
 *
 * A sync that would end many sign-ins at once is not believed (`holdReason`, the one place that
 * decides): it is recorded as a hold, changes nothing, and waits for an Admin.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";
import type { DirectorySnapshot, DirectorySource } from "./directory.ts";
import { appendLineDurably } from "./jsonl.ts";
import type { Role } from "./principals.ts";

/** docs/107 §3. `asked` is "asked to join": signed in through the door, not activated. */
export type DirectoryPersonState = "listed" | "asked" | "active" | "left";

interface Named { subject: string; name: string }
interface Stamp { at: string; source: DirectorySource }

export type ActivationEvent =
  | (Stamp & Named & { type: "activate-person"; by: string; role: Role; listed: boolean })
  | (Stamp & { type: "activate-department"; by: string; role: Role; department: { vendorId: string; name: string }; includeSub: boolean; count: number; alreadyActive: number; people: Named[] })
  | (Stamp & Named & { type: "request" })
  | (Stamp & { type: "dismiss"; by: string; subject: string })
  /** The roster people an activation made (INV-2220): one line for the act, however many. `migrated`: made after the fact, by home format 2 or by a server start, from an activation that had made nobody. */
  | (Stamp & { type: "enrolled"; people: { subject: string; principalId: string }[]; migrated?: true })
  /** The activated person's first sign-in through the door. Before INV-2220 this was also when the roster gained them. */
  | (Stamp & { type: "admitted"; subject: string; principalId: string })
  /** Personal boxes asked for on these roster people's behalf: `by` the Admin who activated them, or `start` for the ones a server start caught up on. */
  | (Stamp & { type: "boxes"; by: string; count: number; people: string[] })
  /** Activated before the directory listed them, and a later sync did. */
  | (Stamp & { type: "listed"; subjects: string[] })
  | (Stamp & Named & { type: "left"; principalId?: string })
  /** A sync that would have ended too many sign-ins at once: nothing was changed, and an Admin decides. */
  | (Stamp & { type: "hold"; reason: HoldReason; standing: number; people: Named[] })
  | (Stamp & { type: "hold-dismissed"; by: string })
  /** An Admin confirmed a held sync: exactly these people left, as one act. */
  | (Stamp & { type: "left-confirmed"; by: string; count: number; people: (Named & { principalId?: string })[] });

/** Why a sync was held: it lists nobody, its head count fell by more than half, or it would end many sign-ins at once. */
export type HoldReason = "empty" | "halved" | "many";
export interface HeldSync { at: string; reason: HoldReason; standing: number; people: Named[] }

/** More than this many people leaving in one sync, and more than this share of the source's standing activations, is not believed without an Admin. */
export const HOLD_OVER_PEOPLE = 5;
export const HOLD_OVER_SHARE = 0.1;

/**
 * The brake on a sync, decided here and nowhere else: a vendor answer that is successful and short
 * (a narrowed contact scope, a department the app can no longer read, a partial walk) must not sign
 * an organisation out. A sync that would end somebody's sign-in is held, changing nothing, when it
 * lists nobody at all, when it lists fewer than half the people the last one did, or when more than
 * `HOLD_OVER_PEOPLE` people and more than `HOLD_OVER_SHARE` of the standing activations would leave.
 */
export function holdReason(sync: { leaving: number; standing: number; listedNow: number; listedBefore: number | undefined }): HoldReason | undefined {
  if (sync.leaving === 0) return undefined;
  if (sync.listedNow === 0) return "empty";
  if (sync.listedBefore !== undefined && sync.listedNow * 2 < sync.listedBefore) return "halved";
  if (sync.leaving > HOLD_OVER_PEOPLE && sync.leaving > sync.standing * HOLD_OVER_SHARE) return "many";
  return undefined;
}

type Unstamped = ActivationEvent extends infer E ? (E extends ActivationEvent ? Omit<E, "at"> : never) : never;

export interface Activation extends Named {
  role: Role;
  by: string;
  at: string;
  department?: { vendorId: string; name: string };
  /** The directory has listed this person since the activation: only then can a sync say they left. */
  listed: boolean;
  /** The roster person the activation made, and comes back to. */
  principalId?: string;
  /** When the roster gained them: at the activation, or at their first sign-in for one older than INV-2220. */
  enrolledAt?: string;
  /** Their first sign-in through the door. */
  admittedAt?: string;
  /**
   * Made a roster person after the fact — by home format 2 from an activation older than INV-2220,
   * or by a server start finishing one — and not by the Admin's press itself. No box is asked for
   * on their behalf: they get theirs at their first use, whatever `personalBoxAt` says now.
   */
  migrated?: true;
  leftAt?: string;
}
export interface JoinRequest extends Named { at: string }

export function sourceKey(source: DirectorySource): string {
  return JSON.stringify([source.channelId, source.incarnation, source.tenantKey]);
}

const ROLES: readonly Role[] = ["viewer", "driver", "admin"];
export function activationRole(value: unknown): Role | undefined {
  return ROLES.find(role => role === value);
}

/** A department and, when asked, everything under it. A parent chain that loops ends. */
export function departmentScope(snapshot: DirectorySnapshot, vendorId: string, includeSub: boolean): Set<string> {
  const scope = new Set([vendorId]);
  if (!includeSub) return scope;
  for (let grew = true; grew; ) {
    grew = false;
    for (const department of snapshot.departments) {
      if (department.parentVendorId !== null && scope.has(department.parentVendorId) && !scope.has(department.vendorId)) { scope.add(department.vendorId); grew = true; }
    }
  }
  return scope;
}

export interface DepartmentNode { vendorId: string; name: string; parentVendorId: string | null; direct: number; total: number }

/**
 * The directory as a tree with a head count per department: `direct` in it, `total` with everything
 * under it, each person once. A department the vendor only refers to (Feishu's root `0`) gets a node
 * with no name, so nobody directly under the company is hidden.
 */
export function departmentTree(snapshot: DirectorySnapshot): DepartmentNode[] {
  const known = new Map<string, { name: string; parentVendorId: string | null }>(snapshot.departments.map(row => [row.vendorId, row]));
  for (const id of [...snapshot.departments.map(row => row.parentVendorId), ...snapshot.people.flatMap(person => person.departmentVendorIds)]) {
    if (id !== null && !known.has(id)) known.set(id, { name: "", parentVendorId: null });
  }
  return [...known].map(([vendorId, row]) => {
    const scope = departmentScope({ departments: [...known].map(([id, each]) => ({ vendorId: id, ...each })), people: [] }, vendorId, true);
    return {
      vendorId, name: row.name, parentVendorId: row.parentVendorId !== null && known.has(row.parentVendorId) && row.parentVendorId !== vendorId ? row.parentVendorId : null,
      direct: snapshot.people.filter(person => person.departmentVendorIds.includes(vendorId)).length,
      total: snapshot.people.filter(person => person.departmentVendorIds.some(id => scope.has(id))).length,
    };
  });
}

interface SourceState { source: DirectorySource; lastAt: string; activations: Map<string, Activation>; requests: Map<string, JoinRequest>; held?: HeldSync }

export class Activations {
  private readonly sources = new Map<string, SourceState>();

  constructor(private readonly path = join(agentboxHome(), "activations.jsonl"), private readonly now: () => Date = () => new Date()) {
    if (!existsSync(path)) return;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      // A torn last line is the act that did not happen; every whole line before it did.
      try { this.apply(JSON.parse(line) as ActivationEvent); } catch { /* not a record */ }
    }
  }

  private of(source: DirectorySource): SourceState {
    const key = sourceKey(source);
    let state = this.sources.get(key);
    if (state === undefined) { state = { source, lastAt: "", activations: new Map(), requests: new Map() }; this.sources.set(key, state); }
    return state;
  }

  private apply(event: ActivationEvent): void {
    const state = this.of(event.source);
    if (event.at > state.lastAt) state.lastAt = event.at;
    const activate = (person: Named, role: Role, by: string, listed: boolean, department?: { vendorId: string; name: string }) => {
      const before = state.activations.get(person.subject);
      state.activations.set(person.subject, {
        ...person, role, by, at: event.at, listed, ...(department ? { department } : {}),
        ...(before?.principalId !== undefined ? { principalId: before.principalId } : {}),
      });
      state.requests.delete(person.subject);
    };
    if (event.type === "activate-person") activate({ subject: event.subject, name: event.name }, event.role, event.by, event.listed);
    else if (event.type === "activate-department") for (const person of event.people) activate(person, event.role, event.by, true, event.department);
    else if (event.type === "request") state.requests.set(event.subject, { subject: event.subject, name: event.name, at: event.at });
    else if (event.type === "dismiss") state.requests.delete(event.subject);
    else if (event.type === "boxes") { /* the audit's, not the state's */ }
    else if (event.type === "enrolled") {
      for (const person of event.people) {
        const activation = state.activations.get(person.subject);
        if (activation !== undefined) { activation.principalId = person.principalId; activation.enrolledAt = event.at; if (event.migrated === true) activation.migrated = true; }
      }
    } else if (event.type === "hold") state.held = { at: event.at, reason: event.reason, standing: event.standing, people: event.people };
    else if (event.type === "hold-dismissed") delete state.held;
    else if (event.type === "left-confirmed") {
      delete state.held;
      for (const person of event.people) { const activation = state.activations.get(person.subject); if (activation !== undefined) activation.leftAt = event.at; }
    } else {
      const subjects = event.type === "listed" ? event.subjects : [event.subject];
      for (const subject of subjects) {
        const activation = state.activations.get(subject);
        if (activation === undefined) continue;
        if (event.type === "listed") activation.listed = true;
        else if (event.type === "admitted") { activation.principalId = event.principalId; activation.admittedAt = event.at; activation.enrolledAt ??= event.at; }
        else activation.leftAt = event.at;
      }
    }
  }

  private record(event: Unstamped): void {
    const stamped = { ...event, at: this.now().toISOString() } as ActivationEvent;
    mkdirSync(dirname(this.path), { recursive: true });
    appendLineDurably(this.path, JSON.stringify(stamped));
    this.apply(stamped);
  }

  activation(source: DirectorySource, subject: string): Activation | undefined { return this.of(source).activations.get(subject); }
  activations(source: DirectorySource): Activation[] { return [...this.of(source).activations.values()]; }
  requests(source: DirectorySource): JoinRequest[] { return [...this.of(source).requests.values()]; }

  /**
   * Per door, the source its newest line was written against. Every line is stamped with the door's
   * app as it was when the line was written, so this is the last app the door was seen with — the
   * nearest a reader without the door's credentials gets to "the door as it is now".
   */
  latestSources(): DirectorySource[] {
    const latest = new Map<string, SourceState>();
    for (const state of this.sources.values()) {
      const seen = latest.get(state.source.channelId);
      if (seen === undefined || state.lastAt > seen.lastAt) latest.set(state.source.channelId, state);
    }
    return [...latest.values()].map(state => state.source);
  }

  /**
   * Standing activations whose roster person has not been made: the act that was interrupted between
   * the ledger and the roster, or one older than INV-2220 that nobody signed in on. `enrol` makes them.
   */
  unenrolled(source: DirectorySource): Activation[] {
    return this.activations(source).filter(activation => activation.enrolledAt === undefined && activation.leftAt === undefined);
  }

  /**
   * Where a directory person stands. `onRoster`: their identity from this door is a roster person's
   * now. An activation that made a roster person whose identity is no longer anybody's — an Admin
   * removed them, or a sync found them gone — is `left`, and makes nobody until an Admin activates again.
   */
  stateOf(source: DirectorySource, subject: string, onRoster: boolean): DirectoryPersonState {
    const state = this.of(source), activation = state.activations.get(subject);
    const left = activation !== undefined && (activation.leftAt !== undefined || (activation.enrolledAt !== undefined && !onRoster));
    if (activation !== undefined && !left) return "active";
    if (onRoster) return "active";
    if (state.requests.has(subject)) return "asked";
    return left ? "left" : "listed";
  }

  activatePerson(source: DirectorySource, person: Named, role: Role, by: string, listed: boolean): void {
    this.record({ type: "activate-person", source, subject: person.subject, name: person.name, role, by, listed });
  }

  /**
   * Everybody the department lists now, as one act and one line. Somebody already active — by an
   * activation still standing, or on the roster through this door some other way — is counted and
   * left as they are: their role is not rewritten by a bulk press.
   */
  activateDepartment(
    source: DirectorySource, snapshot: DirectorySnapshot, vendorId: string, includeSub: boolean, role: Role, by: string, onRoster: (subject: string) => boolean,
  ): { activated: number; alreadyActive: number } | undefined {
    const node = departmentTree(snapshot).find(department => department.vendorId === vendorId);
    if (node === undefined) return undefined;
    const scope = departmentScope(snapshot, vendorId, includeSub);
    const members = snapshot.people.filter(person => person.departmentVendorIds.some(id => scope.has(id)));
    const people = members.filter(person => this.stateOf(source, person.vendorSubject, onRoster(person.vendorSubject)) !== "active")
      .map(person => ({ subject: person.vendorSubject, name: person.name }));
    const result = { activated: people.length, alreadyActive: members.length - people.length };
    this.record({
      type: "activate-department", source, by, role, department: { vendorId, name: node.name }, includeSub, count: result.activated, alreadyActive: result.alreadyActive, people,
    });
    return result;
  }

  /** One request per person however often they scan; false when it was already there. */
  request(source: DirectorySource, person: Named): boolean {
    if (this.of(source).requests.has(person.subject)) return false;
    this.record({ type: "request", source, ...person });
    return true;
  }

  dismiss(source: DirectorySource, subject: string, by: string): boolean {
    if (!this.of(source).requests.has(subject)) return false;
    this.record({ type: "dismiss", source, subject, by });
    return true;
  }

  enrolled(source: DirectorySource, people: { subject: string; principalId: string }[], migrated = false): void {
    if (people.length > 0) this.record({ type: "enrolled", source, people, ...(migrated ? { migrated: true as const } : {}) });
  }

  /** The first sign-in on a standing activation, once: what "activated, has not signed in yet" is read from. */
  admitted(source: DirectorySource, subject: string, principalId: string): void {
    const activation = this.activation(source, subject);
    if (activation !== undefined && activation.leftAt === undefined && activation.admittedAt === undefined) this.record({ type: "admitted", source, subject, principalId });
  }

  boxesAsked(source: DirectorySource, by: string, people: string[]): void {
    if (people.length > 0) this.record({ type: "boxes", source, by, count: people.length, people });
  }

  listed(source: DirectorySource, subjects: string[]): void {
    if (subjects.length > 0) this.record({ type: "listed", source, subjects });
  }

  left(source: DirectorySource, person: Named, principalId?: string): void {
    this.record({ type: "left", source, ...person, ...(principalId !== undefined ? { principalId } : {}) });
  }

  held(source: DirectorySource): HeldSync | undefined { return this.of(source).held; }

  /** A sync held back. The same people for the same reason is the same hold: the hourly refresh does not write it again. */
  hold(source: DirectorySource, reason: HoldReason, standing: number, people: Named[]): void {
    const before = this.of(source).held, key = (held: { reason: HoldReason; people: Named[] }) => JSON.stringify([held.reason, held.people.map(person => person.subject).sort()]);
    if (before !== undefined && key(before) === key({ reason, people })) return;
    this.record({ type: "hold", source, reason, standing, people });
  }

  /** The hold put away, by an Admin or by a later sync that is believed: the next sync is judged afresh. */
  dismissHold(source: DirectorySource, by: string): boolean {
    if (this.of(source).held === undefined) return false;
    this.record({ type: "hold-dismissed", source, by });
    return true;
  }

  /** A held sync confirmed: who left, as one line naming who confirmed and how many. */
  leftConfirmed(source: DirectorySource, by: string, people: (Named & { principalId?: string })[]): void {
    this.record({ type: "left-confirmed", source, by, count: people.length, people });
  }

  /** The acts as written, newest last: the audit an Admin reads. */
  audit(limit = 200): ActivationEvent[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf8").split("\n").filter(line => line.trim() !== "").slice(-limit);
    return lines.flatMap(line => { try { return [JSON.parse(line) as ActivationEvent]; } catch { return []; } });
  }
}
