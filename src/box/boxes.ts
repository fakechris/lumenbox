/**
 * The boxes an installation drives (docs/30).
 *
 * One installation used to mean one box, and `box.json` beside the agents was that box's
 * identity. This is the list: the same record, plus how each box is reached and where in it
 * we live — its display floor and work directory — because a box somebody else runs (Grok
 * Bot's VM) already has desktops :1..:5 and its own idea of home. The first entry is the
 * installation's own box and keeps the id `box.json` minted, so nothing stamped with that id
 * moves.
 *
 * What is deliberately not here: an agent's membership. `AgentProfile.boxId` is set at
 * creation and never edited (registry.ts), because a worker's authority is its box's and
 * moving one is creating another (docs/22 §0, docs/30 §1).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { BoxRecord } from "./identity.ts";

export type BoxKind = "docker" | "attached";

export interface BoxEntry {
  /** Opaque, minted once. The default box's is `box.json`'s. */
  id: string;
  /** For people and for `box attach <name>`; unique, not the key. */
  name: string;
  kind: BoxKind;
  /**
   * How an attached box is reached. Absent for the Docker box, which the provisioner
   * finds on its own. The token is read from a file, never stored in this record.
   */
  endpoint?: { baseUrl: string; tokenFile: string };
  /** Where this box's desktops start: :1 on our own image, :10 beside Grok Bot. */
  displayFloor: number;
  /** The directory agents work in there. */
  workDir: string;
  members: "everyone" | string[];
  createdAt: string;
}

export const BOXES_FILENAME = "boxes.json";
export const DEFAULT_WORK_DIR = "/home/box/work";

/** A name usable in a path and a command line. */
export const BOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

function writeAtomically(path: string, entries: readonly BoxEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function readEntries(path: string): BoxEntry[] | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} (boxes.json) is not valid JSON. Not rewriting it: agents are stamped with these ids. Restore or remove the file.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${path} (boxes.json) is not a list.`);
  return parsed.map((raw, index) => {
    const entry = raw as Partial<BoxEntry>;
    if (typeof entry.id !== "string" || entry.id === "") throw new Error(`${path}: entry ${index} has no id.`);
    return {
      id: entry.id,
      name: typeof entry.name === "string" && entry.name !== "" ? entry.name : `box-${index + 1}`,
      kind: entry.kind === "attached" ? "attached" : "docker",
      ...(entry.endpoint !== undefined && typeof entry.endpoint.baseUrl === "string"
        ? { endpoint: { baseUrl: entry.endpoint.baseUrl, tokenFile: String(entry.endpoint.tokenFile ?? "") } }
        : {}),
      displayFloor: typeof entry.displayFloor === "number" && entry.displayFloor >= 1 ? Math.floor(entry.displayFloor) : 1,
      workDir: typeof entry.workDir === "string" && entry.workDir !== "" ? entry.workDir : DEFAULT_WORK_DIR,
      members: Array.isArray(entry.members) ? entry.members : "everyone",
      createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
    };
  });
}

/**
 * The list, migrated from the single record on first read: the installation's box becomes
 * entry one, docker, floor 1, and keeps its id. A second call reads the file.
 */
export function ensureBoxes(path: string, own: BoxRecord, options: { displayFloor?: number } = {}): BoxEntry[] {
  const existing = readEntries(path);
  if (existing !== undefined) {
    // The own box must be in the list under its own id: a boxes.json from another
    // installation copied in would otherwise orphan every agent here.
    if (!existing.some(entry => entry.id === own.id)) {
      throw new Error(`${path} (boxes.json) does not contain this installation's box ${own.id}. Not rewriting it.`);
    }
    return existing;
  }
  const first: BoxEntry = {
    id: own.id,
    name: own.name,
    kind: "docker",
    displayFloor: options.displayFloor ?? 1,
    workDir: DEFAULT_WORK_DIR,
    members: own.members,
    createdAt: own.createdAt,
  };
  writeAtomically(path, [first]);
  return [first];
}

export function saveBoxes(path: string, entries: readonly BoxEntry[]): void {
  writeAtomically(path, entries);
}

/** A new attached box. The id is minted here; the token stays in its file. */
export function attachedBox(input: { name: string; baseUrl: string; tokenFile: string; displayFloor?: number; workDir?: string }): BoxEntry {
  if (!BOX_NAME.test(input.name)) throw new Error(`"${input.name}" is not a box name (letters, digits, . _ -, up to 48).`);
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    throw new Error(`"${input.baseUrl}" is not a URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("A box endpoint is http or https.");
  return {
    id: `box_${randomUUID()}`,
    name: input.name,
    kind: "attached",
    endpoint: { baseUrl: input.baseUrl.replace(/\/+$/, ""), tokenFile: input.tokenFile },
    displayFloor: input.displayFloor ?? 1,
    workDir: input.workDir ?? DEFAULT_WORK_DIR,
    members: "everyone",
    createdAt: new Date().toISOString(),
  };
}

/** The token an attached box was started with, read when it is needed and never cached in a record. */
export function tokenOf(entry: BoxEntry): string | undefined {
  if (entry.endpoint === undefined || entry.endpoint.tokenFile === "") return undefined;
  try {
    const value = readFileSync(entry.endpoint.tokenFile, "utf8").trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}
