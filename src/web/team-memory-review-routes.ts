/** Team memory review (INV-1581): the setting, what waits, and a person's decision. Admin only. */

import type { AgentRegistry } from "../agents/registry.ts";
import { saveConfig } from "../config.ts";
import { decideReview, pendingReviews, teamReviewOn } from "../host/team-memory-review.ts";

export async function teamMemoryReviewRoute(
  route: string,
  deps: {
    registry: Pick<AgentRegistry, "readSharedMemory" | "appendSharedMemory" | "tryGet">;
    readJson: () => Promise<Record<string, unknown>>;
    refusedAdmin: () => boolean;
    by: () => string;
    log: (line: string) => void;
  }
): Promise<{ status: number; body: unknown } | undefined> {
  if (!route.startsWith("GET /api/memory/team-review") && !route.startsWith("POST /api/memory/team-review")) return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: null };
  const view = () => ({
    on: teamReviewOn(),
    pending: pendingReviews(deps.registry.readSharedMemory()).map(item => ({
      writer: item.writer,
      writerName: deps.registry.tryGet(item.writer)?.profile.name ?? item.writer,
      version: item.version,
      text: item.record.text,
      at: item.record.at,
      kind: item.record.kind,
    })),
  });
  if (route === "GET /api/memory/team-review") return { status: 200, body: view() };
  const body = await deps.readJson();
  if (route === "POST /api/memory/team-review/setting") {
    if (typeof body.on !== "boolean") return { status: 400, body: { error: "on must be true or false" } };
    saveConfig({ teamMemoryReview: body.on });
    deps.log(`team memory review turned ${body.on ? "on" : "off"} by ${deps.by()}`);
    return { status: 200, body: view() };
  }
  if (route === "POST /api/memory/team-review/decide") {
    const decision = body.decision === "approved" || body.decision === "rejected" ? body.decision : undefined;
    if (decision === undefined) return { status: 400, body: { error: "decision must be approved or rejected" } };
    const result = decideReview(deps.registry, String(body.writer ?? ""), String(body.version ?? ""), decision, deps.by());
    if (!result.ok) return { status: 409, body: { error: result.why, ...view() } };
    deps.log(`team memory: ${deps.by()} ${decision} a write by ${String(body.writer)}`);
    return { status: 200, body: view() };
  }
  return { status: 404, body: { error: `No route ${route}` } };
}
