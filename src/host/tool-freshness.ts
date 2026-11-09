/** Cached past results must not impersonate current observations. This does not grant tool authority. */
import { idempotencyOf, idempotencyOfAnnotations, idempotencyOfHttp } from "../protocol/idempotency.ts";

export function needsFreshObservation(name: string, input: Record<string, unknown>, external: readonly { name: string; annotations?: Record<string, unknown> }[] = []): boolean {
  if (name === "UseMcpTool") {
    const target = String(input.tool ?? "");
    if (target === "UseMcpTool") return false;
    return needsFreshObservation(target, (input.arguments !== null && typeof input.arguments === "object" ? input.arguments : {}) as Record<string, unknown>, external);
  }
  if (idempotencyOf(name).kind === "read" || name === "WebFetch" || name === "WebSearch") return true;
  if (name === "Jobs") return input.action === undefined || input.action === "list" || input.action === "wait";
  if (name === "Tasks") return input.action === undefined || input.action === "list";
  if (name === "Goal") return input.action === "status";
  if (name === "connector_request") return idempotencyOfHttp(String(input.method ?? "GET")).kind === "read";
  return idempotencyOfAnnotations(external.find(tool => tool.name === name)?.annotations)?.kind === "read";
}
