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
  // An unscoped error can contain a private turn's text. Producers must name its scope.
  return false;
}
