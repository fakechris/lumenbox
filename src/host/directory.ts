/**
 * The synced org: departments and people, as installation state (docs/35 §3).
 *
 * The directory is vendor data, and it gets exactly the trust chatKeys get:
 * it is a *record* consulted at admission, never authority of its own. A
 * person becomes a Principal only at authentication (login or first
 * message) — a directory row with no Principal is nothing but a row.
 *
 * The honest scope rule is the one decision here that is not bookkeeping:
 * an app sees the users its contact scope grants — sometimes the whole
 * tenant, sometimes only the app's visible range — and **absence
 * deactivates only under full visibility**. A partial view that silently
 * dropped absentees would take away people's access because somebody
 * narrowed an app's visibility, which reads exactly like a bug and is
 * worse than one. Visibility is therefore a claim the operator makes
 * about what they granted in the vendor console (`directoryVisibility` on
 * the door record), defaulting to the safe `partial`; the day a vendor
 * offers a provable answer, the claim can be measured instead of made.
 *
 * `~/.agentbox/directory.json`, 0600 like the roster: it is the org's
 * people, and who reads it is a question worth limiting.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";

export interface DirectoryDepartment {
  /** The vendor's stable id — a box binding will name it (docs/35 §3). */
  vendorId: string;
  name: string;
  parentVendorId: string | null;
}

export interface DirectoryPerson {
  /** The subject the door's inbound messages carry — the identity's other half. */
  vendorSubject: string;
  name: string;
  departmentVendorIds: string[];
  title?: string;
  active: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ChannelDirectory {
  channelId: string;
  syncedAt: string;
  visibility: "full" | "partial";
  departments: DirectoryDepartment[];
  people: DirectoryPerson[];
}

/** What a provider fetched: the org as the app can see it, nothing more. */
export interface DirectorySnapshot {
  departments: DirectoryDepartment[];
  people: Array<{
    vendorSubject: string;
    name: string;
    departmentVendorIds: string[];
    title?: string;
  }>;
}

/** What a merge did, for the log line and the admin who pressed the button. */
export interface DirectoryChanges {
  added: number;
  renamed: number;
  reactivated: number;
  deactivated: number;
  departments: number;
}

export function directoryPath(): string {
  return process.env.AGENTBOX_DIRECTORY ?? join(agentboxHome(), "directory.json");
}

interface DirectoryFile {
  channels: Record<string, ChannelDirectory>;
}

/**
 * The pure half of a sync: the snapshot merges over what was there.
 *
 * - Departments replace wholesale — the snapshot is the structure as the
 *   vendor holds it, and there is nothing to keep.
 * - A person in the snapshot is active, with their fields refreshed.
 * - A person absent from the snapshot is deactivated **only under full
 *   visibility**; under partial, `lastSeenAt` stands still and says so.
 * - Deactivated people are kept, not deleted: reactivation on return, and
 *   "who left" is an audit question, not a spacing problem.
 */
export function mergeDirectory(
  existing: ChannelDirectory | undefined,
  channelId: string,
  snapshot: DirectorySnapshot,
  visibility: "full" | "partial",
  now: string,
): { merged: ChannelDirectory; changes: DirectoryChanges } {
  const peopleBySubject = new Map(snapshot.people.map(person => [person.vendorSubject, person]));
  const merged: ChannelDirectory = {
    channelId,
    syncedAt: now,
    visibility,
    departments: snapshot.departments,
    people: [],
  };
  const changes: DirectoryChanges = {
    added: 0,
    renamed: 0,
    reactivated: 0,
    deactivated: 0,
    departments: snapshot.departments.length,
  };

  // Everyone the snapshot knows, in snapshot order, then the survivors of the
  // old row (in their old order) — a merge that reorders people reorders logs.
  const ordered = [...snapshot.people];
  if (existing !== undefined) {
    for (const old of existing.people) {
      if (!peopleBySubject.has(old.vendorSubject)) ordered.push({
        vendorSubject: old.vendorSubject,
        name: old.name,
        departmentVendorIds: old.departmentVendorIds,
        ...(old.title !== undefined ? { title: old.title } : {}),
      });
    }
  }
  const oldBySubject = new Map((existing?.people ?? []).map(person => [person.vendorSubject, person]));
  for (const person of ordered) {
    const old = oldBySubject.get(person.vendorSubject);
    if (old === undefined) {
      changes.added++;
      merged.people.push({
        ...person,
        active: true,
        firstSeenAt: now,
        lastSeenAt: now,
      });
      continue;
    }
    if (old.name !== person.name) changes.renamed++;
    const present = peopleBySubject.has(person.vendorSubject);
    if (present) {
      if (!old.active) changes.reactivated++;
      merged.people.push({
        ...person,
        active: true,
        firstSeenAt: old.firstSeenAt,
        lastSeenAt: now,
      });
    } else {
      // Absent from the snapshot. The visibility rule decides what that means,
      // and under `partial` it must mean nothing at all.
      const deactivates = visibility === "full" && old.active;
      if (deactivates) changes.deactivated++;
      merged.people.push({
        ...old,
        active: deactivates ? false : old.active,
      });
    }
  }
  return { merged, changes };
}

/** The store: one file, every door's directory, read on demand like the roster. */
export class Directories {
  private channels = new Map<string, ChannelDirectory>();

  constructor(private readonly path: string = directoryPath()) {
    this.reload();
  }

  reload(): void {
    this.channels.clear();
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<DirectoryFile>;
      for (const [channelId, directory] of Object.entries(parsed.channels ?? {})) {
        if (directory?.channelId === channelId && Array.isArray(directory.people)) {
          this.channels.set(channelId, directory);
        }
      }
    } catch {
      // A broken file is no directories, not a broken server: auto-link stops
      // offering, sync rewrites the file, nothing else changes.
    }
  }

  of(channelId: string): ChannelDirectory | undefined {
    return this.channels.get(channelId);
  }

  /**
   * The active person a door's subject resolves to — the auto-link lookup.
   * Inactive and unknown are the same answer: link nothing.
   */
  personOf(channelId: string, vendorSubject: string): DirectoryPerson | undefined {
    const person = this.channels.get(channelId)?.people.find(
      candidate => candidate.vendorSubject === vendorSubject,
    );
    return person?.active === true ? person : undefined;
  }

  merge(
    channelId: string,
    snapshot: DirectorySnapshot,
    visibility: "full" | "partial",
    now: string,
  ): DirectoryChanges {
    const { merged, changes } = mergeDirectory(this.channels.get(channelId), channelId, snapshot, visibility, now);
    this.channels.set(channelId, merged);
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    const file: DirectoryFile = { channels: Object.fromEntries(this.channels) };
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.path);
    chmodSync(this.path, 0o600);
    return changes;
  }
}
