/** Host-issued review authority. A background lane alone grants no isolation or write rights. */
import { createHash } from "node:crypto";
import type { InboundMessage } from "../agents/admitted-message.ts";
import type { TaskStore } from "./tasks.ts";
import { evidenceDigest } from "./review-dispatch.ts";

export interface AuditContext { taskId: string; digest: string; reviewerId: string; planId?: string; paths?: readonly string[]; assigneeId?: string; sourceConversation?: string }
export const AUDIT_READ_TOOLS = new Set(["ReadHistory", "Tasks", "read_file", "list_dir", "NothingToSay"]);

export function auditConversation(scope: AuditContext): string {
  return "audit-" + createHash("sha256").update(JSON.stringify([scope.taskId, scope.digest, scope.reviewerId, scope.planId])).digest("hex").slice(0, 32);
}
export function auditCurrent(scope: AuditContext, agentId: string, conversation: string, tasks?: TaskStore): boolean {
  const task = tasks?.get(scope.taskId);
  return scope.reviewerId === agentId && conversation === auditConversation(scope) && task?.status === "review" &&
    task.assigneeId !== agentId && task.requester !== agentId && evidenceDigest(task) === scope.digest;
}
export function admittedAudit(messages: readonly InboundMessage[]): AuditContext | undefined {
  const first = messages[0]?.audit;
  return first && messages.every(message => message.origin === "host:audit" && message.audit &&
    JSON.stringify(message.audit) === JSON.stringify(first)) ? first : undefined;
}
export function auditToolAllowed(scope: AuditContext, name: string, input: unknown): boolean {
  if (!AUDIT_READ_TOOLS.has(name)) return false;
  if (scope.planId && (name === "Recall" || name === "ReadHistory" && ((input as { agent?: string; conversation?: string })?.agent !== scope.assigneeId || ((input as { conversation?: string })?.conversation ?? "main") !== scope.sourceConversation))) return false;
  if (scope.planId && (name === "read_file" || name === "list_dir")) {
    const path = (input as { path?: string })?.path;
    return typeof path === "string" && !!scope.paths?.includes(path);
  }
  if (name !== "Tasks") return true;
  const args = input as { action?: unknown; id?: unknown } | null;
  return args?.action === "read" && args.id === scope.taskId;
}
