/** Events carry the same agent, box or task scope as the operation that produced them. */
export function mayReadScopedEvent(
  event: unknown,
  access: {
    agent(id: string): boolean;
    box(id: string): boolean;
    task(id: string): boolean;
    defaultBox: string;
  },
): boolean {
  const value = event as Record<string, unknown>;
  const agents = [value.agentId, value.fromId, value.toId].filter(
    (id): id is string => typeof id === "string",
  );
  if (agents.length) return agents.every(access.agent);
  if (typeof value.boxId === "string") return access.box(value.boxId);
  if (typeof value.taskId === "string") return access.task(value.taskId);
  if (value.type === "box_setup") return access.box(access.defaultBox);
  // Says only "re-read": what it is about is read from an Admin-only route (INV-2220), so it carries nothing to scope.
  if (value.type === "activation_progress") return Object.keys(value).length === 1;
  // An unscoped error can contain a private turn's text. Producers must name its scope.
  return false;
}
