/**
 * `GET /work`, `/work/{id}`, `/work/{id}/history` and `/board` (docs/106 §4.2): `Work` built from
 * a task, never the task. What waits on the person and the board's order are the page's own
 * (attention.ts, board-order.ts); what may be read is `sightOf` (the page's reach, narrowed by a
 * service token's view); the result line is the board's (`lastReport`).
 */

import type { Task } from "../../host/tasks.ts";
import { answeredInChat } from "../../host/task-audience.ts";
import { tr } from "../../i18n/messages.ts";
import { type BoardItem, boardOrder, isTaskRef } from "../board-order.ts";
import { lastReport } from "../task-board-record.ts";
import type { Call } from "./frame.ts";
import { refuse } from "./frame.ts";
import { apiTime } from "./times.ts";
import { WAIT_KINDS, WORK_STATES } from "./schema.ts";
import { decodeCursor, encodeCursor, limitOf, type Sight, sightOf } from "./visibility.ts";

/** What one call reads work through: who may see what, and what the person owes. */
interface Reading {
  sight: Sight;
  owed: ReadonlyMap<string, BoardItem>;
  mine: readonly BoardItem[];
  theirs: readonly BoardItem[];
  agentName(id: string): string | undefined;
}

function readingOf(call: Call): Reading {
  const sight = sightOf(call);
  const visible = call.deps.world.tasks().filter(sight.task);
  const { mine, theirs } = call.deps.world.attention(call.caller!.person, visible);
  const names = new Map(call.deps.world.agents().map(agent => [agent.id, agent.name]));
  const owed = new Map(mine.filter(item => isTaskRef(item.ref)).map(item => [item.ref, item]));
  return { sight, owed, mine, theirs, agentName: id => names.get(id) };
}

/** The highest piece of work above this one the caller may read: the grouping a client shows. */
function visibleTop(task: Task, sight: Sight): Task {
  let at = task;
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = at.origin?.parentId === undefined ? undefined : sight.byId.get(at.origin.parentId);
    if (parent === undefined || parent.id === task.id || !sight.task(parent)) return at;
    at = parent;
  }
  return at;
}

export function workOf(task: Task, reading: Reading) {
  const { sight } = reading;
  const owed = reading.owed.get(task.id);
  const agentId = task.assigneeId !== undefined && sight.agent(task.assigneeId) ? task.assigneeId : undefined;
  const parent = task.origin?.parentId === undefined ? undefined : sight.byId.get(task.origin.parentId);
  const summary = lastReport(task)?.note;
  return {
    id: task.id,
    title: task.title,
    state: task.status,
    topLevelId: visibleTop(task, sight).id,
    ...(parent !== undefined && sight.task(parent) ? { parentId: parent.id } : {}),
    ...(agentId !== undefined ? { agentId, ...(reading.agentName(agentId) !== undefined ? { agentName: reading.agentName(agentId) } : {}) } : {}),
    ...(task.conversation !== undefined ? { conversationId: task.conversation } : {}),
    waitsOnMe: owed !== undefined,
    ...(owed !== undefined && (WAIT_KINDS as readonly string[]).includes(owed.kind) ? { waitKind: owed.kind } : {}),
    ...(summary !== undefined && summary !== "" ? { summary } : {}),
    ...(sight.text && task.description !== undefined && task.description !== "" ? { description: task.description } : {}),
    deliverableIds: (task.deliverables ?? []).map(file => file.id),
    ...(task.due !== undefined ? { due: task.due } : {}),
    createdAt: apiTime(task.createdAt),
    updatedAt: apiTime(task.updatedAt),
  };
}

/** What the page lists: everything readable, less the questions already answered in a chat (INV-1822). */
const listed = (reading: Reading, call: Call): Task[] => call.deps.world.tasks().filter(task => reading.sight.task(task) && !answeredInChat(task));

const position = (value: unknown): value is [string, string] => Array.isArray(value) && value.length === 2 && value.every(part => typeof part === "string");
/** Most recently changed first; the id breaks a tie, so the order is total and a cursor is exact. */
const newer = (a: readonly [string, string], b: readonly [string, string]): boolean => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

export function listWork(call: Call) {
  const reading = readingOf(call);
  const { state, agentId, topLevelId, waitsOnMe } = call.params;
  const filters = JSON.stringify(["work", state ?? null, agentId ?? null, topLevelId ?? null, waitsOnMe ?? null]);
  const rows = listed(reading, call)
    .filter(task => state === undefined || task.status === state)
    .filter(task => agentId === undefined || (task.assigneeId === agentId && reading.sight.agent(agentId)))
    .filter(task => topLevelId === undefined || visibleTop(task, reading.sight).id === topLevelId)
    .filter(task => waitsOnMe === undefined || reading.owed.has(task.id) === waitsOnMe)
    .map(task => ({ task, key: [task.updatedAt, task.id] as [string, string] }))
    .sort((a, b) => (newer(a.key, b.key) ? -1 : 1));
  const after = decodeCursor(call.params.cursor, filters, position);
  const rest = after === undefined ? rows : rows.filter(row => newer(after, row.key));
  const page = rest.slice(0, limitOf(call));
  return {
    items: page.map(row => workOf(row.task, reading)),
    ...(rest.length > page.length ? { nextCursor: encodeCursor(page.at(-1)!.key, filters) } : {}),
  };
}

function readable(call: Call, reading: Reading): Task {
  const task = reading.sight.byId.get(String(call.params.id));
  return task !== undefined && reading.sight.task(task) ? task : refuse("api-not-found");
}

export function getWork(call: Call) {
  const reading = readingOf(call);
  return workOf(readable(call, reading), reading);
}

export function listWorkHistory(call: Call) {
  const reading = readingOf(call);
  const task = readable(call, reading);
  const filters = JSON.stringify(["history", task.id]);
  const from = decodeCursor(call.params.cursor, filters, (value): value is number => Number.isInteger(value) && (value as number) >= 0) ?? 0;
  const page = task.history.slice(from, from + limitOf(call));
  return {
    items: page.map(change => {
      const actor = call.deps.world.actor(change.by);
      const handedTo = change.assigneeId !== undefined && reading.sight.agent(change.assigneeId) ? change.assigneeId : undefined;
      return {
        at: apiTime(change.at),
        byKind: actor?.kind ?? "system",
        ...(actor !== undefined ? { byId: change.by, byName: actor.name } : {}),
        ...(change.status !== undefined ? { state: change.status } : {}),
        ...(handedTo !== undefined ? { agentId: handedTo } : {}),
        ...(reading.sight.text && change.note !== undefined && change.note !== "" ? { note: change.note } : {}),
      };
    }),
    ...(from + page.length < task.history.length ? { nextCursor: encodeCursor(from + page.length, filters) } : {}),
  };
}

export function getBoard(call: Call) {
  const reading = readingOf(call);
  const rows = boardOrder(listed(reading, call), reading.mine, reading.theirs).map(row => row.task);
  const cards = limitOf(call);
  return {
    columns: WORK_STATES.map(state => {
      const inColumn = rows.filter(task => task.status === state);
      return { id: state, title: tr(`api.board.${state}`, call.locale), total: inColumn.length, cards: inColumn.slice(0, cards).map(task => workOf(task, reading)) };
    }),
  };
}
