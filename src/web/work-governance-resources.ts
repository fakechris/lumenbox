import { pauseManagedMembers } from "./work-control-routes.ts";
import type { Outbox } from "../host/outbox.ts";
import { redactText } from "../host/secret-redaction.ts";
/** Read existing authorities and apply only an explicitly previewed resource scope. */
import { createHash } from "node:crypto";
import type { Orchestrator } from "../host/orchestrator.ts";
import type { AgentPauses } from "../host/agent-pause.ts";
import type { WorkControl } from "../host/work-control.ts";
import type { DeliveryRecovery } from "../host/delivery-recovery.ts";
import {
  resourceKey,
  routineResource,
  type GovernedResource,
  type GovernanceAdapter,
} from "../host/work-governance.ts";
import type { Task } from "../host/tasks.ts";

interface Dependencies {
  by: string;
  host: Orchestrator;
  outbox: Outbox;
  pauses: AgentPauses;
  control: WorkControl;
  replies: DeliveryRecovery;
  external: readonly { agentId: string; handle: string }[];
  mayReadAgent: (id: string) => boolean;
  mayReadTask: (task: Task) => boolean;
  mayReadBox: (id: string) => boolean;
}
const version = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                "Automation inventory unavailable; no absence claim can be made.",
              ),
            ),
          2500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function governanceResources(deps: Dependencies): GovernanceAdapter {
  const { host, pauses, control, replies } = deps;
  const read = (row: GovernedResource) =>
    (row.kind !== "outbound" ||
      host.registry.listBoxes().every((box) => deps.mayReadBox(box.id))) &&
    (!row.agentId || deps.mayReadAgent(row.agentId)) &&
    (!row.boxId || deps.mayReadBox(row.boxId)) &&
    (!row.taskId ||
      !host.tasks?.get(row.taskId) ||
      deps.mayReadTask(host.tasks.get(row.taskId)!));
  return {
    mayRead: read,
    inspect(row) {
      if (row.kind === "member" && row.agentId) {
        const id = row.agentId, bus = host.bus.snapshot();
        return { ...row, members: [row.title], coverage: [{kind:"turn",count:bus.running.filter(run=>run.agentId===id).length},{kind:"message",count:bus.queued.filter(item=>item.agentId===id).length},{kind:"job",count:host.jobWatch.snapshot().filter(job=>job.agentId===id).length},{kind:"delegate",count:host.acpDelegates.list().filter(session=>session.agentId===id).length}] };
      }
      if (row.kind !== "work") return row;
      const preview = control.preview({
        taskId: row.taskId,
        agentId: row.agentId ?? "",
        conversation: row.conversation ?? "main",
      });
      if (
        preview.legacy ||
        preview.participants.some((agent) => !deps.mayReadAgent(agent.id)) ||
        preview.resources.some(
          (resource) =>
            resource.kind === "task" &&
            host.tasks?.get(resource.id) &&
            !deps.mayReadTask(host.tasks.get(resource.id)!),
        )
      )
        throw Error("Complete work scope unavailable.");
      const counts = new Map<string, number>();
      for (const resource of preview.resources)
        counts.set(resource.kind, (counts.get(resource.kind) ?? 0) + 1);
      return {
        ...row,
        members: preview.participants.map((agent) => agent.name),
        coverage: [...counts].map(([kind, count]) => ({ kind, count })),
      };
    },
    prepare(selections, by) {
      for (const { row, action } of selections)
        if (action === "pause" && row.agentId)
          pauses.barrier(
            [row.agentId],
            by,
            "Operator paused the explicitly selected member",
          );
    },
    async inventory() {
      const rows: GovernedResource[] = [],
        unknown: string[] = [];
      const add = (
        row: Omit<GovernedResource, "version">,
        identity: unknown = row,
      ) =>
        rows.push({
          ...row,
          title: redactText(row.title).slice(0, 200),
          version: version(identity),
        });
      const tasks = host.tasks?.list() ?? [],
        names = new Map(
          host.registry.list().map((agent) => [agent.id, agent.profile.name]),
        );
      const taskForWork = new Map(
        tasks
          .filter((task) => task.workRoot)
          .map((task) => [task.workRoot!.state.id, task]),
      );
      const seen = new Set<string>();
      for (const task of tasks) {
        const root = task.workRoot?.state,
          trusted = root && !root.unresolved;
        if (trusted && !seen.has(root.id)) {
          seen.add(root.id);
          const participants = [root.owner, ...root.peers];
          if (participants.some((id) => !deps.mayReadAgent(id))) continue;
          add(
            {
              key: resourceKey("work", root.id),
              kind: "work",
              title: task.title,
              section: "history",
              state: root.status,
              source: "linkedWork",
              agentId: root.owner,
              taskId: task.id,
              conversation: root.conversation,
              actions:
                root.status === "cancelled" ||
                task.status === "done" ||
                task.status === "dropped"
                  ? []
                  : ["stop"],
              scope: "wholeWork",
              unknown: ["externalEffects"],
              target: {
                taskId: task.id,
                agentId: root.owner,
                conversation: root.conversation,
              },
            },
            [root.id, root.generation, root.epoch, task.status, root.status],
          );
        } else if (!trusted) {
          add(
            {
              key: resourceKey("record", task.id),
              kind: "record",
              title: task.title,
              section: "history",
              state:
                task.status === "done" || task.status === "dropped"
                  ? "ended"
                  : "unverified",
              source: task.origin?.kind ?? "unknown",
              agentId: task.assigneeId,
              taskId: task.id,
              conversation: task.conversation,
              actions: [],
              scope: "recordOnly",
              unknown: ["unlinkedWork"],
              target: {},
            },
            [task.id, task.updatedAt],
          );
        }
        if (
          task.pursuit &&
          ["active", "verifying", "paused"].includes(task.pursuit.status)
        )
          add(
            {
              key: resourceKey("goal", task.pursuit.workId),
              kind: "goal",
              title: task.pursuit.objective,
              section: "future",
              state: task.pursuit.status,
              source: "goal",
              agentId: task.assigneeId,
              taskId: task.id,
              condition: "goalContinuation",
              actions: ["stop"],
              scope: "goalOnly",
              unknown: ["externalEffects"],
              target: { taskId: task.id, workId: task.pursuit.workId },
            },
            [task.id, task.pursuit.workId],
          );
      }
      const bus = host.bus.snapshot();
      for (const run of bus.running)
        add(
          {
            key: resourceKey(
              "execution",
              JSON.stringify([run.agentId, run.conversation]),
            ),
            kind: "execution",
            title:
              taskForWork.get(run.workId ?? "")?.title ??
              names.get(run.agentId) ??
              "Execution",
            section: "running",
            state: "running",
            source: run.workId ? "linkedExecution" : "unknown",
            agentId: run.agentId,
            conversation: run.conversation,
            taskId: taskForWork.get(run.workId ?? "")?.id,
            actions: [],
            scope: "executionOnly",
            unknown: ["pauseMemberForUnlinked"],
            target: {},
          },
          run,
        );
      for (const job of host.jobWatch.snapshot()) add({ key: resourceKey("job", job.jobId), kind: "job", title: redactText(job.command).slice(0,160), section:"running", state:"pending", source:"backgroundProcess",agentId:job.agentId,conversation:job.conversation,taskId:taskForWork.get(job.work?.id ?? "")?.id,actions:[],scope:"executionOnly",unknown:["pauseMemberForUnlinked","externalEffects"],target:{} },[job.jobId,job.startedAt]);
      for (const session of host.acpDelegates.list()) add({ key:resourceKey("delegate",session.jobId),kind:"delegate",title:names.get(session.agentId) ?? "External executor",section:session.busy?"running":"future",state:session.busy?"running":"waiting",source:"engineSession",agentId:session.agentId,condition:"engineRequest",actions:[],scope:"executionOnly",unknown:["pauseMemberForUnlinked","externalEffects"],target:{} },[session.jobId,session.busy]);
      for (const { agentId, message } of bus.queued)
        add(
          {
            key: resourceKey("message", message.id),
            kind: "message",
            title: message.text.slice(0, 160),
            section: "future",
            state: "queued",
            source: message.origin
              ? "host"
              : message.work
                ? "linkedWork"
                : "unknown",
            agentId,
            taskId: message.taskBinding?.taskId ?? message.work?.taskId,
            conversation: message.conversation,
            condition: "queueAdmission",
            actions: ["stop"],
            scope: "messageOnly",
            unknown: ["otherMessagesRemain"],
            target: { id: message.id },
          },
          [agentId, message.id],
        );
      for (const turn of host.turns?.interrupted() ?? []) {
        const running = bus.running.some(
          (run) =>
            run.agentId === turn.agentId &&
            run.conversation === (turn.conversation ?? "main"),
        );
        if (running) continue;
        add(
          {
            key: resourceKey("recovery", turn.id),
            kind: "recovery",
            title: turn.about,
            section: "future",
            state: "recovery",
            source: "interrupted",
            agentId: turn.agentId,
            conversation: turn.conversation,
            taskId: turn.taskBinding?.taskId,
            condition: "restartRecovery",
            actions: ["stop"],
            scope: "attemptOnly",
            unknown: ["otherMessagesRemain"],
            target: { id: turn.id },
          },
          [turn.id, turn.workId],
        );
      }
      for (const item of host.pendingWork?.open() ?? [])
        add(
          {
            key: resourceKey("pending", item.id),
            kind: item.kind === "reminder" ? "reminder" : "pending",
            title: item.brief,
            section: item.kind === "reminder" ? "future" : "running",
            state: "pending",
            source: item.kind,
            agentId: item.agentId,
            taskId: taskForWork.get(item.workId ?? "")?.id,
            conversation: item.parent,
            next: typeof item.data?.at === "string" ? item.data.at : undefined,
            condition: item.kind === "reminder" ? "reminderDue" : "callback",
            actions: ["stop"],
            scope: "callbackOnly",
            unknown: ["externalEffects", "externalProcessMayContinue"],
            target: { id: item.id },
          },
          [item.id, item.workId],
        );
      try {
        const [routines, listeners] = await bounded(
          Promise.all([host.scheduler.status(), host.scheduler.listening()]),
        );
        for (const item of [
          ...routines.map((row) => ({
            ...row,
            condition: row.kind === "webhook" ? "webhookCall" : "schedule",
            next: row.nextRun,
          })),
          ...listeners.map((row) => ({
            ...row,
            condition: "matchingMessage",
            next: undefined,
            paused: row.paused ?? false,
            agent: row.runAs,
          })),
        ]) {
          const key = routineResource(item);
          const existing = rows.find(row => row.key === key); if (existing) { existing.conditions = [...new Set([...(existing.conditions ?? []), item.condition])]; continue; }
          const agentId = item.agent
            ? (host.registry.tryGet(item.agent)?.id ??
              host.registry
                .list()
                .find((agent) => agent.profile.name === item.agent)?.id)
            : undefined;
          add(
            {
              key,
              kind: "routine",
              title: item.name,
              section: "future",
              state: item.paused
                ? "paused"
                : item.mode === "off"
                  ? "disabled"
                  : "enabled",
              source: "automation",
              agentId,
              boxId: item.boxId ?? host.registry.box.id,
              conditions: [item.condition], condition: item.condition,
              next: item.next,
              actions: ["disable"],
              scope: "triggerOnly",
              unknown: ["existingExecutionsRemain", "futureCountUnbounded"],
              target: { slug: item.slug, boxId: item.boxId ?? "" },
            },
            [key, item.agent, item.condition],
          );
        }
      } catch {
        unknown.push("automationUnavailable");
      }
      // An offline box may contain routines that cannot currently be inventoried.
      if (
        host.registry
          .listBoxes()
          .filter((box) => deps.mayReadBox(box.id))
          .some(
            (box) =>
              !host.registry
                .list()
                .some(
                  (agent) =>
                    host.registry.boxOf(agent.id).id === box.id &&
                    host.boxFor(agent.id),
                ),
          )
      )
        unknown.push("offlineBoxUnknown");
      for (const entry of deps.external)
        add(
          {
            key: resourceKey("external", entry.agentId),
            kind: "external",
            title: `${names.get(entry.agentId) ?? entry.handle} · Involute`,
            section: "future",
            state: "enabled",
            source: "externalRequests",
            agentId: entry.agentId,
            condition: "externalPoll",
            actions: ["disable"],
            scope: "externalEntryOnly",
            unknown: ["existingExecutionsRemain", "remoteRequestsRemain"],
            target: { agentId: entry.agentId },
          },
          entry.agentId,
        );
      for (const receipt of deps.outbox.entries())
        if (receipt.status === "pending")
          add(
            {
              key: resourceKey("outbox", receipt.id),
              kind: "outbound",
              title: redactText(receipt.text ?? "Old outbound message").slice(
                0,
                160,
              ),
              section: "history",
              state: "pending",
              source: "transport",
              condition: "replyDelivery",
              actions: ["discard"],
              scope: "replyOnly",
              unknown: ["externalEffects", "deliveryNotAcceptance"],
              target: { id: receipt.id, chatKey: receipt.chatKey },
            },
            [receipt.id, receipt.status],
          );
      for (const row of replies.list(
        Number.MAX_SAFE_INTEGER,
        0,
        (row) =>
          deps.mayReadAgent(row.agentId) &&
          (!row.taskId ||
            !host.tasks?.get(row.taskId) ||
            deps.mayReadTask(host.tasks.get(row.taskId)!)),
        true,
      ))
        add(
          {
            key: resourceKey("reply", row.id),
            kind: "reply",
            title: row.title,
            section: "history",
            state: row.phase,
            source: row.source,
            agentId: row.agentId,
            taskId: row.taskId,
            conversation: row.conversation,
            condition: "replyDelivery",
            actions: row.canDiscard ? ["discard"] : [],
            scope: "replyOnly",
            unknown: [
              "deliveryNotAcceptance",
              ...(row.externalEffectUnconfirmed ? ["externalEffects"] : []),
            ],
            target: { id: row.id },
          },
          [row.id, row.phase, row.source],
        );
      for (const agent of host.registry.list()) {
        const pause = pauses.pauseOf(agent.id);
        add(
          {
            key: resourceKey("member", agent.id),
            kind: "member",
            title: agent.profile.name,
            section: "members",
            state: pause ? "paused" : "enabled",
            source: "member",
            agentId: agent.id,
            actions: pause ? [] : ["pause"],
            scope: "allMemberWork",
            unknown: ["pauseNotPermanent", "externalEffects"],
            target: { agentId: agent.id },
          },
          [agent.id, pause],
        );
      }
      for (const operation of host.governance.pendingOperations()) if (operation.by === deps.by && operation.selections.every(selection => read(selection.row))) add({key:resourceKey("operation",operation.id),kind:"operation",title:operation.selections.map(selection=>selection.row.title).slice(0,2).join(" · "),section:"history",state:"unconfirmed",source:"operatorDisposition",actions:[],scope:"retryOnly",unknown:["externalEffects"],target:{id:operation.id}},[operation.id,operation.results]);
      if (host.registry.listBoxes().length) unknown.push("catalogBoundary");
      return { rows, unknown };
    },
    async apply(row, action, by) {
      if (action === "pause" && row.agentId) {
        const result = await pauseManagedMembers(host, pauses, [row.agentId], by, "Operator paused the selected member");
        return { confirmed: !result.failures.length && result.results.every(item => !item.result.errors?.length && !item.result.jobsUnconfirmed?.length) && result.nativeStops.every(item => item.state === "confirmed"), detail: "pauseNotPermanent" };
      }
      if (action === "disable" && ["routine", "external"].includes(row.kind))
        return { confirmed: true, detail: "existingExecutionsRemain" };
      if (action === "discard" && row.kind === "outbound") {
        deps.outbox.dropped(
          row.target.id!,
          "Discarded from global work management",
        );
        return { confirmed: true, detail: "externalEffects" };
      }
      if (action === "discard" && row.kind === "reply") {
        const reply = replies.preview(row.target.id!);
        if (!reply) throw Error("Reply unavailable");
        const result = replies.discard(reply.id, reply.token, by);
        return { confirmed: result.phase === "discarded" };
      }
      if (row.kind === "work") {
        const preview = control.preview({
          taskId: row.taskId,
          agentId: row.agentId ?? "",
          conversation: row.conversation ?? "main",
        });
        if (
          preview.legacy ||
          !preview.token ||
          preview.participants.some((agent) => !deps.mayReadAgent(agent.id)) ||
          preview.resources.some(
            (resource) =>
              resource.kind === "task" &&
              host.tasks?.get(resource.id) &&
              !deps.mayReadTask(host.tasks.get(resource.id)!),
          )
        )
          throw Error("Complete linked work scope is unavailable.");
        const result = await control.cancel(
          preview.target,
          preview.token,
          by,
          "Stopped from global work management",
        );
        return {
          confirmed: result.resources.every(
            (resource) => resource.state === "confirmed",
          ),
          detail: "externalEffects",
        };
      }
      if (row.kind === "goal") {
        const task = host.tasks?.get(row.taskId!);
        if (!task?.pursuit || task.pursuit.workId !== row.target.workId)
          throw Error("Goal changed");
        host.tasks!.setPursuit(
          task.id,
          (pursuit) => ({
            ...pursuit,
            status: "paused",
            pausedReason: "person",
            pausedBy: by,
          }),
          "Stopped from global work management",
        );
        host.bus.interruptWork(row.target.workId!);
        return { confirmed: true, detail: "externalEffects" };
      }
      if (row.kind === "message") {
        host.bus.discardRevoked();
        return {
          confirmed: !host.bus
            .snapshot()
            .queued.some((item) => item.message.id === row.target.id),
        };
      }
      if (row.kind === "recovery") {
        host.turns?.end(row.target.id!, "resource-stopped");
        return { confirmed: true };
      }
      if (row.kind === "pending" || row.kind === "reminder") {
        host.pendingWork?.dropped(row.target.id!, "cancelled");
        return { confirmed: true, detail: "externalProcessMayContinue" };
      }
      throw Error("This record has no supported control action.");
    },
  };
}
