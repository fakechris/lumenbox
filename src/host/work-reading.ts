/** One read contract for user work. It explains existing facts; it grants no execution authority. */
import type { Task } from "./tasks.ts";
import { taskStage, type StageWorld } from "./task-stage.ts";
import type { CheckSnapshot } from "./result-check-policy.ts";
import { evidenceDigest, type VerificationRecord } from "./review-dispatch.ts";

export type WorkSource = "user" | "collaboration" | "internal" | "unknown";
export interface WorkReference {
  title: string;
  id?: string;
  availability: "available" | "unavailable";
  relation: "parent" | "dependency" | "collaboration";
}
export interface WorkReading {
  id: string;
  title: string;
  phase: string;
  reason: string;
  source: WorkSource;
  evidenceVersion: string;
  blocker?: { kind: string; tools: string[] };
  boundary: "linked" | "historical" | "unverified";
  conversation?: { agentId: string; id: string };
  references: WorkReference[];
  moreReferences: number;
  checks: {
    state: "manual" | "authorized" | "running" | "stopped";
    result: "passed" | "failed" | "disagreement" | "incomplete" | "notChecked";
    purpose?: string;
    reason?: string;
    rounds: number;
    calls: number;
    reservedCost: number;
  };
  evidence: string[];
  actions: { kind: "open" | "conversation" | "result" | "process"; scope: "work" | "conversation" }[];
}

export function workSource(task: Task): WorkSource {
  if (task.origin?.parentId) return "collaboration";
  return task.origin?.kind ?? "unknown";
}
export function workReference(
  id: string,
  relation: WorkReference["relation"],
  lookup: (id: string) => Task | undefined,
  allowed: (task: Task) => boolean,
): WorkReference {
  const task = lookup(id);
  return task && allowed(task)
    ? { id: task.id, title: task.title, availability: "available", relation }
    : { title: "", availability: "unavailable", relation };
}
export function workReading(
  task: Task,
  world: { stage: StageWorld; checks: CheckSnapshot; references?: WorkReference[]; verdicts?: VerificationRecord[] },
): WorkReading {
  const latest = world.checks.plans.filter(plan => plan.taskId === task.id).at(-1);
  const current = latest?.digest === evidenceDigest(task) ? latest : undefined;
  const verdicts = current
      ? (world.verdicts ?? []).filter(row => !current.reviewers.length || current.reviewers.includes(row.reviewerId))
      : [],
    needed = Math.max(1, current?.reviewers.length ?? 0);
  const passed = verdicts.filter(row => row.verdict === "pass").length,
    failed = verdicts.filter(row => row.verdict === "fail").length;
  const checks: WorkReading["checks"] = {
    result:
      passed && failed
        ? "disagreement"
        : passed >= needed
          ? "passed"
          : failed >= needed
            ? "failed"
            : verdicts.length
              ? "incomplete"
              : "notChecked",
    state:
      current?.phase === "running" && world.stage.checkPending === false
        ? "stopped"
        : (current?.phase ?? (world.checks.policy.mode === "manual" ? "manual" : "authorized")),
    ...(world.checks.policy.mode !== "manual" ? { purpose: world.checks.policy.reason } : {}),
    ...(current?.reason ? { reason: current.reason } : {}),
    rounds: world.checks.rounds,
    calls: world.checks.calls,
    reservedCost: world.checks.reservedCost,
  };
  const stage = taskStage(task, { ...world.stage, checkPending: checks.state === "running" });
  const phase = task.proposedBy
    ? "proposal"
    : task.status === "dropped"
      ? "dropped"
      : stage === "ended"
        ? "ended"
        : stage === "working"
          ? "working"
          : stage === "working/queued"
            ? "queued"
            : stage === "review"
              ? "checking"
              : stage === "person/review"
                ? "review"
                : stage.startsWith("person/")
                  ? "needs"
                  : "waiting";
  const boundary = task.workRoot?.state.unresolved ? "unverified" : task.workRoot ? "linked" : "historical";
  const reason = phase === "waiting" && boundary !== "linked" ? "historicalWaiting" : phase;
  const references = world.references ?? [];
  const root = task.workRoot?.state,
    blocker =
      root?.status === "waiting"
        ? {
            kind: root.reason === "failed" ? "failed" : root.reason === "aborted" ? "interrupted" : (root.wait ?? "execution"),
            tools: [...new Set((root.unavailable ?? []).map(row => row.tool))],
          }
        : undefined;
  return {
    ...(blocker ? { blocker } : {}),
    id: task.id,
    title: task.title,
    phase,
    reason,
    source: workSource(task),
    boundary,
    checks,
    evidenceVersion: evidenceDigest(task),
    ...(task.assigneeId && task.conversation ? { conversation: { agentId: task.assigneeId, id: task.conversation } } : {}),
    actions: [
      { kind: "open", scope: "work" },
      { kind: task.status === "review" || task.status === "done" ? "result" : "process", scope: "work" },
      ...(task.assigneeId && task.conversation ? [{ kind: "conversation" as const, scope: "conversation" as const }] : []),
    ],
    references: references.slice(0, 12),
    moreReferences: Math.max(0, references.length - 12),
    evidence: (
      task.history
        .slice()
        .reverse()
        .find(row => row.evidence?.length)?.evidence ?? []
    ).slice(0, 6),
  };
}
