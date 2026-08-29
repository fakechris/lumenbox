/**
 * Channel records: the door as an entity, with an id a rename cannot break.
 *
 * docs/22 §2/§4: a channel is a door into exactly one box. Its `id` is immutable
 * and mints every identity and chatKey under it; `name` is a display label and
 * nothing persistent hangs on it. The three singletons this replaces are
 * grandfathered with their type as their id — `feishu:ou_x` strings recorded over
 * months keep resolving because `feishu` *is* that door's id now, not its type.
 *
 * `incarnation` is present in the schema and pinned to 1 by validation. That is
 * deliberate, not unfinished: docs/22 §7 item 2 makes namespace replacement one
 * atomic migration (identity links, ChatRefs, CAS on every identity writer), and
 * shipping a bumpable counter before that migration exists is exactly the reviewed
 * failure — a colliding vendor subject from the new tenant inheriting an old
 * principal's role. Until the migration is built, a bumped incarnation refuses to
 * load, loudly, at startup.
 *
 * Credentials are not in the record. Where they live is a docs/15 decision this
 * file does not preempt; the grandfathered rows keep reading their env pairs.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ChannelType = "feishu" | "dingtalk" | "telegram";

export const GRANDFATHERED_TYPES: readonly ChannelType[] = ["feishu", "dingtalk", "telegram"];

export interface ChannelRecord {
  /** Immutable. Mints identities (`<id>:ou_x`) and chatKeys. Grandfathered rows: the type. */
  id: string;
  /** Which adapter drives this door. */
  type: ChannelType;
  /** Display label. Renameable because nothing keys on it. */
  name: string;
  /** Pinned to 1 until the docs/22 §7 item 2 migration exists. */
  incarnation: number;
  /** The box this door opens into (docs/22 §2: routing, not authorization). */
  boxId: string;
  /**
   * Who answers a message that names nobody (docs/22 §2). An agent name or id;
   * absent falls through to the installation default. Routing, not a permission:
   * `@Name` still reaches any agent in the box.
   */
  defaultAgent?: string;
  createdAt: string;
}

export const CHANNEL_RECORDS_FILENAME = "channels.json";

interface ChannelsFile {
  channels: ChannelRecord[];
}

/**
 * Loads the channel records at `path`, minting the grandfathered rows on first
 * contact and re-adding any that went missing from a hand edit. Idempotent; the
 * file is rewritten only when something was added.
 */
export function ensureChannelRecords(path: string, boxId: string): ChannelRecord[] {
  let existing: ChannelRecord[] = [];
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(
        `${path} (channels.json) is not valid JSON. Not re-minting channel ids over it: ` +
          `recorded identities and chatKeys key on them. Restore or remove the file.`
      );
    }
    const rows = (parsed as Partial<ChannelsFile>).channels;
    existing = Array.isArray(rows) ? rows.filter(isChannelRecord) : [];
    for (const record of existing) {
      if (record.incarnation !== 1) {
        throw new Error(
          `channel ${record.id} has incarnation ${record.incarnation}, and namespace ` +
            `replacement is not built yet (docs/22 §7 item 2: the identity-link migration ` +
            `must land first). Refusing to start rather than letting a colliding vendor ` +
            `subject inherit an old principal.`
        );
      }
    }
  }

  const now = new Date().toISOString();
  let added = false;
  for (const type of GRANDFATHERED_TYPES) {
    if (existing.some(record => record.id === type)) continue;
    existing.push({ id: type, type, name: type, incarnation: 1, boxId, createdAt: now });
    added = true;
  }

  if (added || !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ channels: existing }, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  }
  return existing;
}

/**
 * Creates a door, or edits the two fields of one that may change.
 *
 * `id` and `type` are identity and are immutable — editing them would be the
 * rename-breaks-everything bug §4 of docs/22 exists to kill; `name` and
 * `defaultAgent` are a label and a routing choice, freely changeable. New rows
 * are limited to types whose adapter is prefix-parameterized (feishu today):
 * recording a door that would mint colliding identities the moment it started
 * is not configuration, it is a trap with a delay on it.
 */
export function upsertChannelRecord(
  path: string,
  input: { id: string; type: ChannelType; name?: string; defaultAgent?: string | null },
  boxId: string
): ChannelRecord[] {
  const id = input.id.trim();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
    throw new Error(
      `"${id}" cannot be a channel id: lowercase letters, digits and hyphens, ` +
        `starting with a letter, at most 32 characters. It becomes the prefix of ` +
        `every identity this door mints, so it is chosen once and never edited.`
    );
  }
  if ((GRANDFATHERED_TYPES as readonly string[]).includes(id) && id !== input.type) {
    throw new Error(`"${id}" is the ${id} adapter's own namespace; a ${input.type} door cannot take it.`);
  }
  const records = ensureChannelRecords(path, boxId);
  const existing = records.find(record => record.id === id);
  let updated: ChannelRecord[];
  if (existing !== undefined) {
    if (existing.type !== input.type) {
      throw new Error(`${id} is a ${existing.type} door; its type is immutable, like its id.`);
    }
    updated = records.map(record =>
      record.id !== id
        ? record
        : {
            ...record,
            name: input.name?.trim() ? input.name.trim() : record.name,
            ...(input.defaultAgent === null || input.defaultAgent === ""
              ? { defaultAgent: undefined }
              : input.defaultAgent !== undefined
                ? { defaultAgent: input.defaultAgent }
                : { defaultAgent: record.defaultAgent }),
          }
    );
  } else {
    if (input.type === "telegram") {
      throw new Error(
        `a second telegram door needs that adapter prefix-parameterized first ` +
          `(docs/22 §7 item 3); feishu and dingtalk support it today.`
      );
    }
    updated = [
      ...records,
      {
        id,
        type: input.type,
        name: input.name?.trim() ? input.name.trim() : id,
        incarnation: 1,
        boxId,
        ...(input.defaultAgent ? { defaultAgent: input.defaultAgent } : {}),
        createdAt: new Date().toISOString(),
      },
    ];
  }
  writeChannelRecords(path, updated);
  return updated;
}

/** Removes a door. The grandfathered rows are the product's own and stay. */
export function removeChannelRecord(path: string, id: string, boxId: string): ChannelRecord[] {
  if ((GRANDFATHERED_TYPES as readonly string[]).includes(id)) {
    throw new Error(`${id} is a grandfathered door and cannot be removed.`);
  }
  const records = ensureChannelRecords(path, boxId);
  const updated = records.filter(record => record.id !== id);
  writeChannelRecords(path, updated);
  return updated;
}

function writeChannelRecords(path: string, records: ChannelRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ channels: records }, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

function isChannelRecord(value: unknown): value is ChannelRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<ChannelRecord>;
  return (
    typeof record.id === "string" &&
    record.id !== "" &&
    (GRANDFATHERED_TYPES as readonly string[]).includes(record.type ?? "") &&
    typeof record.incarnation === "number"
  );
}
