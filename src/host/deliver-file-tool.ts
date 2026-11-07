/**
 * DeliverFile (INV-1663): an agent marks a file in its box as what a task produced.
 *
 * The host copies the bytes off the box there and then (task-deliverables.ts), records them on
 * the task, and — in an outside chat — drops a copy in the conversation's outbox, so the chat
 * gets the file the way every outbox file goes out: as a file where the channel carries files,
 * as a line saying it is ready where it does not. The task page lists every delivery with a
 * download, newest first.
 *
 * A file that cannot be opened as its name says is refused (deliverables.ts): recording a broken
 * file as the thing a task produced is the failure this exists to end.
 */
import { MAIN_CONVERSATION } from "../agents/registry.ts";
import { outcomeLine } from "../protocol/index.ts";
import { checkDeliverable } from "./deliverables.ts";
import { WORK_ROOT } from "./named-files.ts";
import { chatFilesRoot } from "./prompt.ts";
import { alreadyDelivered, DELIVERABLE_LIMIT_BYTES, writeSnapshot } from "./task-deliverables.ts";
import { isLive, type Task } from "./tasks.ts";
import type { ToolContext, ToolOutcome } from "./tools.ts";

export const DELIVER_FILE = "DeliverFile";

export function withDeliverFileTool(tools: { name: string; input_schema: unknown }[]): void {
  tools.push({
    name: DELIVER_FILE,
    description:
      "Mark a file in your box as what a task produced — its deliverable. The host keeps a copy as it is now " +
      "(later edits in the box do not change it), lists it on the task's page with a download, and in an outside " +
      "chat sends it into the chat with your reply. Use it for the report, deck, sheet or export the task was for, " +
      "once it is finished; call it again for each file, and again after a revision (each delivery is kept). " +
      "A file that cannot be opened as its name says is refused. Not for scratch files or notes.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: `The file's absolute path, under ${WORK_ROOT}/.` },
        note: { type: "string", description: "One line on what it is, for the person who opens it." },
        task_id: { type: "string", description: "The task it belongs to, e.g. \"t12\". Omit when you have one live task." },
      },
      required: ["path", "note"],
    },
  } as never);
}

function refused(reason: string): ToolOutcome {
  return { text: outcomeLine("refused", reason), isError: true };
}

/** The task a delivery is for: the one named, or the caller's one live task (in this conversation first). */
function taskFor(context: ToolContext, named: string): Task | string {
  const board = context.tasks!;
  if (named !== "") return board.get(named) ?? `there is no task ${named}`;
  const mine = board.list().filter(task => isLive(task.status) && task.assigneeId === context.agent.id && task.proposedBy === undefined);
  const here = mine.filter(task => task.conversation === context.conversation);
  const pick = here.length === 1 ? here : mine;
  if (pick.length === 1) return pick[0]!;
  return pick.length === 0
    ? "you have no live task to deliver to; give task_id"
    : `you have ${pick.length} live tasks (${pick.map(task => task.id).join(", ")}); give task_id`;
}

export async function deliverFileTool(context: ToolContext, input: Record<string, unknown>): Promise<ToolOutcome> {
  const board = context.tasks;
  if (board === undefined || board.path === null) return refused("there is no task board to record a deliverable on");
  if (context.box === undefined) return refused("there is no box to take the file from");
  const path = String(input.path ?? "").trim();
  const note = String(input.note ?? "").trim();
  if (!path.startsWith(`${WORK_ROOT}/`) || path.split("/").includes("..")) return refused(`path must be a file under ${WORK_ROOT}/`);
  if (note === "") return refused("note says in one line what the file is");
  const task = taskFor(context, String(input.task_id ?? "").trim());
  if (typeof task === "string") return refused(task);
  if (!isLive(task.status)) return refused(`${task.id} is ${task.status}; a closed task takes no new deliverables`);
  if (task.proposedBy !== undefined) return refused(`${task.id} is a proposal nobody has committed yet`);
  if (task.assigneeId !== undefined && task.assigneeId !== context.agent.id) return refused(`${task.id} is assigned to someone else; only its assignee delivers for it`);

  let bytes: Buffer;
  try {
    const file = await context.box.downloadFile(path);
    if (file.size > DELIVERABLE_LIMIT_BYTES) return refused(`${path} is ${file.size} bytes, past the 25MB limit; split or compress it`);
    bytes = Buffer.from(file.base64, "base64");
  } catch (error) {
    return { text: outcomeLine("failed", `${path} could not be read (${error instanceof Error ? error.message : String(error)})`), isError: true };
  }
  if (bytes.length > DELIVERABLE_LIMIT_BYTES) return refused(`${path} is past the 25MB limit; split or compress it`);
  const name = path.split("/").pop()!;
  const problems = checkDeliverable(name, bytes);
  const broken = problems.filter(problem => problem.severity === "broken");
  if (broken.length > 0) return refused(`${name} cannot be opened as its name says: ${broken.map(problem => problem.detail).join("; ")}. Regenerate it in the real format, then deliver it`);

  const sha256 = writeSnapshot(board.path, task.id, bytes);
  const again = alreadyDelivered(task, name, sha256);
  const item = again ?? board.deliver(task.id, {
    name, path, size: bytes.length, sha256, note, at: new Date().toISOString(), by: context.agent.id,
    ...(context.turnId !== undefined ? { run: context.turnId } : {}),
  });
  if (item === undefined) return refused(`there is no task ${task.id}`);

  // An outside chat gets the file through its outbox, the one path files take into a chat.
  let chat = "";
  const conversation = context.conversation ?? MAIN_CONVERSATION;
  if (conversation !== MAIN_CONVERSATION) {
    const outbox = `${chatFilesRoot(conversation, { kind: context.boxKind, workDir: context.boxWorkDir })}/outbox`;
    if (path.startsWith(`${outbox}/`)) chat = " It is already in this chat's outbox and goes out with your reply.";
    else {
      try {
        await context.box.exec(`mkdir -p '${outbox.replace(/'/g, `'\\''`)}'`, { actor: "host:deliver-file" });
        await context.box.uploadFile(`${outbox}/${name}`, bytes.toString("base64"));
        chat = " A copy is in this chat's outbox and goes out with your reply.";
      } catch (error) {
        chat = ` It could not be put in this chat's outbox (${error instanceof Error ? error.message : String(error)}); copy it to ${outbox}/ yourself.`;
      }
    }
  }
  const suspect = problems.filter(problem => problem.severity === "suspect").map(problem => problem.detail);
  return {
    text:
      `${outcomeLine("ok")} ${again !== undefined ? `Already delivered: ${name} is ${item.id} on ${task.id}, the same bytes.` : `${name} (${bytes.length} bytes) is ${item.id} on ${task.id}: kept as it is now, listed on the task with a download.`}${chat}` +
      (suspect.length > 0 ? `\nIt opens, but looks unfinished: ${suspect.join("; ")}. If that is not what was asked for, fix it and deliver again.` : ""),
  };
}
