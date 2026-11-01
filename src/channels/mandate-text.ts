/** What a chat says about a task's mandate (INV-1457): the refusal a person reads, and the note a turn is told. */

/** What a person is told when a task's mandate no longer holds (INV-1457). */
export function reauthorisationNeeded(taskId: string, mandate: { status: string; reasons?: readonly string[] }): string {
  if (mandate.status === "withdrawn") return `任务 ${taskId} 已被叫停，不再接收追加或恢复；如需继续，请发起新请求。`;
  const why = (mandate.reasons ?? []).map(reason => REAUTH_REASONS[reason] ?? reason).join("；");
  return `任务 ${taskId} 需要重新授权：${why}。请发起人确认后再继续，或叫停它。`;
}
const REAUTH_REASONS: Record<string, string> = {
  "requester-cannot-drive": "发起它的人现在没有在这里指挥工作的权限",
  "rules-changed": "授权后操作者的规则已变更",
  "source-disabled": "它所依据的自动化已停用",
};
/** The line a turn is told when the person's message itself re-authorised the task. */
export function mandateNote(reauthorised: readonly string[] | undefined): string {
  return reauthorised === undefined || reauthorised.length === 0 ? "" : `\n[Mandate: the person re-authorised this task with this message after: ${reauthorised.join(", ")}. Treat the operator's current rules as the ones in force.]`;
}
