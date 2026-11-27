/**
 * Admission to an organisation by an Admin's activation (INV-2202, docs/107 §2–§4).
 *
 * Signing in through a door proves who somebody is; it does not let them in. An Admin activates a
 * person, or everybody a department lists at that moment, and **the activation is a record, not a
 * roster row**: the directory source, the person's subject in it, the role, who activated and when,
 * and the department it came from. It becomes a person on the roster only when that subject signs in
 * and the vendor vouches for it (`src/web/activation-routes.ts`), so the rule on `Directories` — a
 * directory row never creates or merges a Principal — still stands.
 *
 * `activations.jsonl` is append-only and never compacted: one line per act, which makes it the
 * audit too. A department activation is one line naming the department, how many people and which
 * role, never one line per person. State is the fold of the lines, keyed by the whole source
 * (door, incarnation, tenant), so an activation made against one door does not apply to its
 * replacement.
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
  | (Stamp & { type: "admitted"; subject: string; principalId: string })
  /** Activated before the directory listed them, and a later sync did. */
  | (Stamp & { type: "listed"; subjects: string[] })
  | (Stamp & Named & { type: "left"; principalId?: string });

type Unstamped = ActivationEvent extends infer E ? (E extends ActivationEvent ? Omit<E, "at"> : never) : never;

export interface Activation extends Named {
  role: Role;
  by: string;
  at: string;
  department?: { vendorId: string; name: string };
  /** The directory has listed this person since the activation: only then can a sync say they left. */
  listed: boolean;
  /** The roster person the sign-in made, and came back to. */
  principalId?: string;
  admittedAt?: string;
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

interface SourceState { activations: Map<string, Activation>; requests: Map<string, JoinRequest> }

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
    if (state === undefined) { state = { activations: new Map(), requests: new Map() }; this.sources.set(key, state); }
    return state;
  }

  private apply(event: ActivationEvent): void {
    const state = this.of(event.source);
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
    else {
      const subjects = event.type === "listed" ? event.subjects : [event.subject];
      for (const subject of subjects) {
        const activation = state.activations.get(subject);
        if (activation === undefined) continue;
        if (event.type === "listed") activation.listed = true;
        else if (event.type === "admitted") { activation.principalId = event.principalId; activation.admittedAt = event.at; }
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

  /** An activation nobody has signed in on yet, or whose person left and was activated again: the one a sign-in may use. */
  pending(source: DirectorySource, subject: string): Activation | undefined {
    const activation = this.activation(source, subject);
    return activation !== undefined && activation.admittedAt === undefined && activation.leftAt === undefined ? activation : undefined;
  }

  /**
   * Where a directory person stands. `onRoster`: their identity from this door is a roster person's
   * now. An activation somebody signed in on whose identity is no longer anybody's — an Admin removed
   * them, or a sync found them gone — is `left`, and admits nobody until an Admin activates again.
   */
  stateOf(source: DirectorySource, subject: string, onRoster: boolean): DirectoryPersonState {
    const state = this.of(source), activation = state.activations.get(subject);
    const left = activation !== undefined && (activation.leftAt !== undefined || (activation.admittedAt !== undefined && !onRoster));
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

  admitted(source: DirectorySource, subject: string, principalId: string): void {
    this.record({ type: "admitted", source, subject, principalId });
  }

  listed(source: DirectorySource, subjects: string[]): void {
    if (subjects.length > 0) this.record({ type: "listed", source, subjects });
  }

  left(source: DirectorySource, person: Named, principalId?: string): void {
    this.record({ type: "left", source, ...person, ...(principalId !== undefined ? { principalId } : {}) });
  }

  /** The acts as written, newest last: the audit an Admin reads. */
  audit(limit = 200): ActivationEvent[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf8").split("\n").filter(line => line.trim() !== "").slice(-limit);
    return lines.flatMap(line => { try { return [JSON.parse(line) as ActivationEvent]; } catch { return []; } });
  }
}
