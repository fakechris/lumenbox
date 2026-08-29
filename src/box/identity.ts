/**
 * The box's identity: an opaque id that a display name can never impersonate.
 *
 * docs/22 §4: names are labels, ids are identity. Destroying a box retires its id
 * forever; a new box under the same display name is a different box and inherits
 * nothing. Both reviewed failure shapes trace to a reusable string standing in for
 * identity — `config.boxes[name]` inheriting a dead box's class, and `classifyBox`
 * keyed by a URL in attached deployments — and this record is what replaces the
 * string. docs/22 §7 item 1: the id arrives first, and carries **no authorization**;
 * membership machinery comes later, and until it does `members` is `"everyone"`,
 * which is today's box named honestly.
 *
 * The record lives beside the roster it scopes (the agents root), so a custom or
 * temporary root carries its own box identity and never touches the installation's.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface BoxRecord {
  /** Opaque, minted once, never reused. The identity everything else binds to. */
  id: string;
  /** The display name at mint time. A label for people; nothing keys on it. */
  name: string;
  /**
   * Who the box's authority belongs to (docs/22 §0): `"everyone"`, or — once
   * docs/22 §7 item 5 exists — a set of Principal ids. One member is a private
   * box; the whole installation is the shared box we run today.
   */
  members: "everyone" | string[];
  createdAt: string;
}

export const BOX_RECORD_FILENAME = "box.json";

/**
 * Loads the box record at `path`, minting it on first contact.
 *
 * A corrupt file throws instead of re-minting: a fresh id under agents already
 * stamped with the old one would orphan them all silently, which is the exact
 * name-reuse inheritance bug the id exists to kill. The operator gets the path
 * and fixes or removes the file deliberately.
 */
export function ensureBoxRecord(path: string, name: string): BoxRecord {
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(
        `${path} (box.json) is not valid JSON. Not re-minting a box id over it: ` +
          `agents stamped with the old id would be orphaned. Restore or remove the file.`
      );
    }
    const record = parsed as Partial<BoxRecord>;
    if (typeof record.id !== "string" || record.id === "") {
      throw new Error(
        `${path} (box.json) has no id. Not re-minting over it — restore or remove the file.`
      );
    }
    return {
      id: record.id,
      name: typeof record.name === "string" && record.name !== "" ? record.name : name,
      members: Array.isArray(record.members) ? record.members : "everyone",
      createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
    };
  }

  const record: BoxRecord = {
    id: `box_${randomUUID()}`,
    name,
    members: "everyone",
    createdAt: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  // Temp file plus rename, like the agent profiles: a reader must never see half a record.
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(temp, path);
  return record;
}
