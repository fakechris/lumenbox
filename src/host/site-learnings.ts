/**
 * Site learnings by box (INV-1728, docs/98 §9 row 7 and §10 decision 6).
 *
 * A new `NoteSiteLearning` note is L2 knowledge: it is kept for the box the writing agent lives
 * in and read only by agents of that box, for a principal who may enter it. The scope is the one
 * memory records use — `box:<id>`, checked by `scopeAdmits` (memory-scope.ts) — so there is one
 * notion of who may read what; here it is stamped on the directory rather than on each line,
 * because a note is a line of Markdown with no room for a field.
 *
 * Layout, under the learnings root (`learningsDir()`, ~/.agentbox/learnings):
 *
 *   <host>.md                    historical, installation-wide: every box reads them, as before
 *   boxes/<box id>/<host>.md     new notes, one directory per box
 *
 * The box directories sit under `boxes/` rather than beside the host files so that the top level
 * stays exactly the historical set — nothing a person or a script lists there changes meaning —
 * and a box id can never be read as a host. Nothing here moves, copies or rewrites a historical
 * file; how a note is shared across boxes is left to a later study.
 */

import { join } from "node:path";
import type { BoxEntry } from "../box/boxes.ts";
import { LEARNINGS_SHOWN, appendLearning, learningsDir, readLearnings, renderLearnings } from "./learnings.ts";
import { scopeAdmits, type MemoryReader, type MemoryScope } from "./memory-scope.ts";

/** The scope a new note is kept under: the writer's box. */
export function learningScope(boxId: string): MemoryScope {
  return `box:${boxId}`;
}

/** Where a box's notes live under the learnings root. */
export function boxLearningsDir(root: string, boxId: string): string {
  const segment = encodeURIComponent(boxId);
  if (segment === "" || segment === "." || segment === "..") throw new Error(`Box id "${boxId}" cannot name a learnings directory.`);
  return join(root, "boxes", segment);
}

/** What a tool turn carries that this needs: where learnings live, who is asking, and the registry's boxes. */
export interface SiteLearningsContext {
  learningsDir?: string;
  agent: { id: string; profile: { name: string } };
  caller?: { userId?: string };
  registry: {
    boxOf(agentId: string): Pick<BoxEntry, "id">;
    boxById(id: string): Pick<BoxEntry, "id" | "members"> | undefined;
  };
}

function readerOf(context: SiteLearningsContext): { root: string; reader: MemoryReader } {
  const reader: MemoryReader = {
    agentId: context.agent.id,
    boxId: context.registry.boxOf(context.agent.id).id,
    boxById: id => context.registry.boxById(id),
    ...(context.caller?.userId !== undefined ? { principalId: context.caller.userId } : {}),
  };
  return { root: context.learningsDir ?? learningsDir(), reader };
}

/** Keeps a note for the writing agent's box. Returns the line as written; throws the refusal. */
export function noteSiteLearning(host: string, entry: { at: Date; worked: boolean; text: string }, context: SiteLearningsContext): string {
  const { root, reader } = readerOf(context);
  return appendLearning(host, { ...entry, by: context.agent.profile.name }, boxLearningsDir(root, reader.boxId));
}

/** The notes this turn may read for a host: its box's (when admitted), then the historical ones, newest kept within `limit`. */
export function readSiteLearnings(host: string, context: SiteLearningsContext, limit = LEARNINGS_SHOWN): { box: string[]; historical: string[] } {
  const { root, reader } = readerOf(context);
  const box = scopeAdmits(learningScope(reader.boxId), undefined, reader) ? readLearnings(host, boxLearningsDir(root, reader.boxId), limit) : [];
  const room = limit - box.length;
  return { box, historical: room > 0 ? readLearnings(host, root, room) : [] };
}

/** The note shown on `browser_open`, or undefined when there is nothing to show. */
export function siteLearningsNote(host: string, context: SiteLearningsContext): string | undefined {
  const notes = readSiteLearnings(host, context);
  return renderLearnings(host, notes.box, notes.historical);
}
