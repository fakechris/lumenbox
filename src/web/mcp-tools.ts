/**
 * The person's side door, as tools (docs/14, INV-1358): what an outside MCP client — another
 * agent, a script — may ask this installation to do. Moved out of server.ts so the contract
 * (mcp-contract.ts) and the tools that honour it live together.
 */

import type { AgentRegistry } from "../agents/registry.ts";
import type { Orchestrator } from "../host/orchestrator.ts";
import type { StageWorld } from "../host/task-stage.ts";
import { describeTask, isLive, type Task } from "../host/tasks.ts";
import type { TurnEvent } from "../host/turn.ts";
import { describeOutcome, outcomeOf } from "./mcp-contract.ts";
import { mcpGoalTools } from "./mcp-goal-tools.ts";
import { taskRecord } from "./mcp-record.ts";
import { type ChangeFeed, describeWatch, WAIT_MAX_SECONDS } from "./mcp-watch.ts";
import type { McpServerTool } from "./mcp-server.ts";

export interface McpToolsDeps {
  registry: AgentRegistry;
  orchestrator: Orchestrator;
  principals: { resolve(id: string): { name: string } };
  workDir: string;
  log: (line: string) => void;
  /** Turn events, for as long as the listener is registered: how a task learns its turn stopped itself. */
  listen: (listener: (event: TurnEvent) => void) => () => void;
  /** What the stage table reads beside a task (INV-1506); absent, a record carries no stage. */
  stageWorld?: (task: Task) => StageWorld;
  /** Whether a principal may drive an agent's box; given, the goal tools are on the door (INV-1507). */
  mayDrive?: (agentId: string, principalId: string) => boolean;
  /** The board's changes as a feed; given, `watch` is on the door (INV-1508). */
  changeFeed?: ChangeFeed;
}

export function mcpServerTools(deps: McpToolsDeps): McpServerTool[] {
  const { registry, orchestrator, principals, workDir, log } = deps;
  const nameOf = (id: string) => registry.tryGet(id)?.profile.name ?? id;
  const recordOf = (task: Task) => taskRecord(task, { nameOf, ...(deps.stageWorld !== undefined ? { stageWorld: deps.stageWorld } : {}) });
  /** task_status, once: the text it always said, and the same tasks as the record has them (INV-1506). */
  const statusOf = (input: Record<string, unknown>, principalId: string): { text: string; structured: Record<string, unknown> } => {
    const board = orchestrator.tasks;
    if (board === undefined) return { text: "This installation has no task board.", structured: { tasks: [] } };
    const id = typeof input.task_id === "string" ? input.task_id : "";
    if (id === "") {
      const mine = board.list().filter(task => task.requester === principalId && isLive(task.status));
      return {
        text: mine.length === 0 ? "Nothing of yours is still open." : mine.map(task => `${describeOutcome(outcomeOf(task))}\n${describeTask(task, nameOf)}`).join("\n"),
        structured: { tasks: mine.map(recordOf) },
      };
    }
    const task = board.get(id);
    if (task === undefined) return { text: `No task ${id}.`, structured: { tasks: [] } };
    // Anyone with a token may read any task: the board is the team's shared record,
    // and hiding a colleague's row from a colleague's agent would be theatre.
    const history = task.history
      .map(change => `  ${change.at} ${nameOf(change.by)} ${change.status ?? ""} ${change.note ?? ""}`.trimEnd())
      .join("\n");
    return { text: `${describeOutcome(outcomeOf(task))}\n${describeTask(task, nameOf)}\n${history}`, structured: { tasks: [recordOf(task)] } };
  };
  return [
    {
      name: "assign_task",
      description:
        "Hand a piece of work to this installation's team of agents. They have a " +
        "persistent Linux box with a desktop and a browser, so this is for work that " +
        "needs a computer of its own or outlives your session. Returns a task id; ask " +
        "about it later with task_status rather than waiting. Send an Idempotency-Key " +
        "(header, _meta.idempotencyKey or idempotency_key) to make a retry return this answer instead of a second task.",
      inputSchema: {
        type: "object",
        properties: {
          brief: { type: "string", description: "The whole request, self-contained." },
          agent: { type: "string", description: "Which agent, by name. Omit for the coordinator." },
        },
        required: ["brief"],
      },
      readOnly: false,
      run: async (input, principalId) => {
        const brief = String(input.brief ?? "").trim();
        if (brief === "") throw new Error("A task needs a brief.");
        const agentName = typeof input.agent === "string" ? input.agent : undefined;
        const agent =
          agentName !== undefined
            ? registry.resolve(agentName)
            : (registry.list()[0] ?? orchestrator.ensureDefaultAgent());
        const task = orchestrator.tasks?.create({
          title: brief.split("\n", 1)[0] ?? brief,
          description: brief,
          requester: principalId,
          assigneeId: agent.id,
        });
        // The turn's own stop (INV-1354 budget, the loop detector) is written on the task before
        // it closes, so task_status can say `incomplete (turn_budget)` rather than `done`.
        const stop = task === undefined ? () => {} : deps.listen(event => {
          if (event.agentId !== agent.id || (event.conversation !== undefined && event.conversation !== "main")) return;
          if (event.type === "turn_budget_hit") orchestrator.tasks?.update(task.id, { status: "review", note: `incomplete (turn_budget): ${event.calls} model calls, handed back` }, agent.id);
          if (event.type === "stuck") orchestrator.tasks?.update(task.id, { status: "review", note: `incomplete (rounds): ${event.reason.split("\n")[0]?.slice(0, 160) ?? "stopped"}` }, agent.id);
        });
        // Not awaited: the caller gets an id now and asks later, which is the only
        // shape that works for work measured in minutes. The task closes when the turn does.
        void orchestrator
          .prompt(agent.id, brief, { userId: principalId }, { lane: "agent" })
          .then(() => { if (task !== undefined) orchestrator.tasks?.turnFinished(task.id); })
          .catch(error => {
            const detail = error instanceof Error ? error.message : String(error);
            log(`mcp task failed: ${detail}`);
            if (task !== undefined) orchestrator.tasks?.update(task.id, { status: "blocked", note: `turn failed: ${detail.slice(0, 200)}` }, agent.id);
          })
          .finally(stop);
        return task === undefined
          ? `${agent.profile.name} is on it.`
          : `${task.id} — ${agent.profile.name} is on it. Ask task_status about ${task.id}.\nstatus: in_progress`;
      },
    },
    {
      name: "task_status",
      description:
        "How a task is going: its state (in_progress | completed | failed | incomplete | cancelled, " +
        "with the reason), who has it, and every move anybody made on it. With no id, the tasks you asked for that are still open. " +
        "structuredContent carries the same tasks as data: outcome, stage, mandate, recent history, and a goal's checklist and spend.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string", description: "A task id like t42." } },
      },
      readOnly: true,
      run: async (input, principalId) => statusOf(input, principalId).text,
      runWithRecord: async (input, principalId) => statusOf(input, principalId),
    },
    {
      name: "list_agents",
      description: "Who is on this installation's team, and what each is for.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      run: async () =>
        registry
          .list()
          .map(agent => `${agent.profile.name}${agent.profile.title ? ` (${agent.profile.title})` : ""} — ${agent.profile.description.slice(0, 160)}`)
          .join("\n") || "No agents yet.",
    },
    {
      name: "run_on_box",
      description:
        "Run a shell command on this installation's box — a persistent Linux machine " +
        "with a real filesystem, where installed tools stay installed and files " +
        "outlive your session. Not your machine and not a scratch container.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string", description: "Defaults to the work directory." },
        },
        required: ["command"],
      },
      readOnly: false,
      run: async (input, principalId) => {
        const client = orchestrator.boxClient();
        if (client === undefined) throw new Error("No box is running on this installation.");
        const command = String(input.command ?? "").trim();
        if (command === "") throw new Error("Nothing to run.");
        // The same gate a resident agent's shell passes, judged under the caller's own
        // name — so an outside agent cannot do what the person holding its token may
        // not, and a dangerous command raises a card to that person's phone.
        const decision = orchestrator.policy.check({
          kind: "tool",
          agentId: `mcp:${principalId}`,
          agentName: principals.resolve(principalId).name,
          tool: "bash",
          input: { command },
        });
        if (!decision.allow) throw new Error(decision.reason);
        const result = await client.exec(command, {
          cwd: typeof input.cwd === "string" ? input.cwd : workDir,
          timeoutMs: 120_000,
          // An outside MCP client driving the shell as a person, not one of our agents:
          // the same principal the policy check above was made against.
          actor: `mcp:${principalId}`,
        });
        return [
          `exit code: ${result.exit_code}`,
          result.stdout.trim() ? `stdout:\n${result.stdout}` : "",
          result.stderr.trim() ? `stderr:\n${result.stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
      },
    },
    {
      name: "box_screenshot",
      description:
        "See the box's desktop as it is now. Useful after asking the team for " +
        "something visual, or before driving it yourself.",
      inputSchema: {
        type: "object",
        properties: { agent: { type: "string", description: "Whose desktop. Defaults to the first." } },
      },
      readOnly: true,
      run: async input => {
        const agent =
          typeof input.agent === "string" ? registry.resolve(input.agent) : registry.list()[0];
        if (agent === undefined) throw new Error("No agents on this installation.");
        const client = orchestrator.boxClient(agent.id);
        if (client === undefined) throw new Error("No box is running for that agent.");
        const shot = await client.computer([{ action: "screenshot" }], {
          display: registry.displayIndexFor(agent.id),
          owner: registry.boxOwnerTokenFor(agent.id),
        });
        // A path rather than the bytes: this bridge carries text, and a screenshot the
        // caller can fetch beats a megabyte of base64 it did not ask for.
        const path = `${workDir}/.mcp-shots/${agent.id}-${Date.now()}.webp`;
        await client.exec(`mkdir -p ${workDir}/.mcp-shots`, { actor: "host:mcp-screenshot" });
        await client.uploadFile(path, shot.screenshot);
        return `Saved the current desktop of ${agent.profile.name} to ${path}.`;
      },
    },
    ...(deps.mayDrive !== undefined ? mcpGoalTools({ registry, orchestrator, mayDrive: deps.mayDrive, nameOf: id => principals.resolve(id).name, log }) : []),
    ...(deps.changeFeed !== undefined ? [watchTool(deps.changeFeed)] : []),
  ];
}

/** `watch` (INV-1508): what moved since the cursor, or the next move, within the caller's wait. */
function watchTool(feed: ChangeFeed): McpServerTool {
  const runWatch = async (input: Record<string, unknown>, principalId: string, signal?: AbortSignal) => {
    const since = typeof input.since === "string" ? input.since : undefined;
    const seconds = typeof input.wait_seconds === "number" && Number.isFinite(input.wait_seconds) ? Math.max(0, Math.min(WAIT_MAX_SECONDS, input.wait_seconds)) : 25;
    const all = input.scope === "all";
    const result = await feed.wait(since, event => all || event.requester === principalId, seconds * 1000, signal);
    return { text: describeWatch(result), structured: { ...result } as Record<string, unknown> };
  };
  return {
    name: "watch",
    description:
      "What changed since your cursor: a task's status, its stage, its goal's status. Waits up to wait_seconds (max " +
      `${WAIT_MAX_SECONDS}) for the next change when there is none. Call first without since to get a cursor. ` +
      "reset: true means some changes are gone; read task_status again. scope: mine (default, tasks you asked for) or all.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "The cursor the last watch returned." },
        wait_seconds: { type: "number" },
        scope: { type: "string", enum: ["mine", "all"] },
      },
    },
    readOnly: true,
    run: async (input, principalId, meta) => (await runWatch(input, principalId, meta?.signal)).text,
    runWithRecord: async (input, principalId, meta) => runWatch(input, principalId, meta?.signal),
  };
}
