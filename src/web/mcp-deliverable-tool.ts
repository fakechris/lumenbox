/**
 * `fetch_deliverable` (INV-1668): a task's handed-over file, through the side door.
 *
 * INV-1663 gave a task deliverables — snapshots taken off the box the moment the agent named
 * them — and a download route on the web app. That route sits behind the UI's sign-in, which
 * an editor holding a side-door token does not have, so an outside agent could see that a
 * task had produced `report.md` and not read it. This is the same snapshot, checked against
 * the same digest, under the same rule for who may read it: whoever may see the task on the
 * board (the caller passes the predicate the board uses, so the two cannot drift).
 *
 * The door carries text. A text file comes back as its text; anything else as base64 in
 * `structuredContent`, up to a cap past which a megabyte of noise in a model's context helps
 * nobody — the task page's download is the way for those, and the answer says so.
 */

import { readSnapshot, type TaskDeliverable } from "../host/task-deliverables.ts";
import type { Task, TaskStore } from "../host/tasks.ts";
import type { McpServerTool } from "./mcp-server.ts";

/** A text file larger than this is cut, and the answer says where. */
export const DELIVERABLE_TEXT_MAX = 256 * 1024;
/** Binary past this is not sent through the door at all. */
export const DELIVERABLE_BASE64_MAX = 1024 * 1024;

/** UTF-8 that round-trips and carries no NUL: what a person would call a text file. */
function asText(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
}

function describe(item: TaskDeliverable): string {
  return `${item.id} ${item.name} (${item.size} bytes, sha256 ${item.sha256}) delivered ${item.at}${item.note !== "" ? ` — ${item.note}` : ""}`;
}

export function fetchDeliverableTool(board: TaskStore, mayReadTask: (task: Task, principalId: string) => boolean): McpServerTool {
  const fetch = async (input: Record<string, unknown>, principalId: string): Promise<{ text: string; structured: Record<string, unknown> }> => {
    const taskId = String(input.task_id ?? "");
    const task = board.get(taskId);
    // Unknown and unreadable answer alike, as the web route does: the door does not say which tasks exist.
    if (task === undefined || !mayReadTask(task, principalId)) throw new Error(`No task ${taskId}.`);
    const items = task.deliverables ?? [];
    if (items.length === 0) return { text: `Task ${task.id} has no deliverables yet. task_status says whether it is still in progress.`, structured: { task_id: task.id, deliverables: [] } };
    const wanted = typeof input.deliverable_id === "string" && input.deliverable_id !== "" ? input.deliverable_id : undefined;
    const item = wanted === undefined ? items.at(-1)! : items.find(entry => entry.id === wanted);
    const listing = items.map(describe).join("\n");
    if (item === undefined) throw new Error(`Task ${task.id} has no deliverable ${wanted}. It has:\n${listing}`);
    const bytes = board.path === null ? undefined : readSnapshot(board.path, task.id, item);
    if (bytes === undefined) throw new Error(`The copy of ${item.name} on task ${task.id} is missing or does not match its digest.`);
    const meta = { id: item.id, name: item.name, size: item.size, sha256: item.sha256, note: item.note, at: item.at };
    const head = `${describe(item)}${items.length > 1 ? `\nAll deliverables on ${task.id}, oldest first:\n${listing}` : ""}`;
    const text = asText(bytes);
    if (text !== undefined) {
      const cut = text.length > DELIVERABLE_TEXT_MAX;
      const body = cut ? text.slice(0, DELIVERABLE_TEXT_MAX) : text;
      return {
        text: `${head}\n\n${body}${cut ? `\n\n[cut at ${DELIVERABLE_TEXT_MAX} characters; the whole file is on the task page]` : ""}`,
        structured: { task_id: task.id, deliverable: meta, encoding: "utf8", truncated: cut, content: body },
      };
    }
    if (bytes.length > DELIVERABLE_BASE64_MAX) {
      return { text: `${head}\n\nNot text, and larger than the ${DELIVERABLE_BASE64_MAX} bytes this door sends; download it from task ${task.id} on the task board.`, structured: { task_id: task.id, deliverable: meta, encoding: "none" } };
    }
    return {
      text: `${head}\n\nNot text: the bytes are in structuredContent.content as base64; decode them to save the file under its name.`,
      structured: { task_id: task.id, deliverable: meta, encoding: "base64", content: bytes.toString("base64") },
    };
  };
  return {
    name: "fetch_deliverable",
    description:
      "Read a file a task handed over as its result (an agent marks it with DeliverFile; the copy is taken when it is marked, " +
      "so later changes on the box do not touch it). Without deliverable_id, the newest. Text comes back as text; other files " +
      "as base64 in structuredContent, up to 1 MiB. task_status lists a task's deliverables.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "A task id like t42." },
        deliverable_id: { type: "string", description: "Which deliverable, like d2. Defaults to the newest." },
      },
      required: ["task_id"],
    },
    readOnly: true,
    run: async (input, principalId) => (await fetch(input, principalId)).text,
    runWithRecord: async (input, principalId) => fetch(input, principalId),
  };
}
