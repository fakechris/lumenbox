/**
 * Team memory review (INV-1581): the setting, what waits, and a person's decision. Admin only.
 * Each waiting write says who may read it once approved — every box, or the writer's box —
 * and `everyone` lists what is already live on every box, for a person to look over (INV-1722).
 */

import type { AgentRegistry } from "../agents/registry.ts";
import { saveConfig } from "../config.ts";
import { memoryView } from "../host/memory-admin.ts";
import { decideReview, pendingReviews, teamReviewOn } from "../host/team-memory-review.ts";
import { apiError } from "./api-error.ts";

export async function teamMemoryReviewRoute(
  route: string,
  deps: {
    registry: Pick<AgentRegistry, "readSharedMemory" | "appendSharedMemory" | "tryGet" | "listBoxes">;
    readJson: () => Promise<Record<string, unknown>>;
    refusedAdmin: () => boolean;
    by: () => string;
    log: (line: string) => void;
  }
): Promise<{ status: number; body: unknown } | undefined> {
  if (!route.startsWith("GET /api/memory/team-review") && !route.startsWith("POST /api/memory/team-review")) return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: null };
  const nameOf = (agentId: string) => deps.registry.tryGet(agentId)?.profile.name ?? agentId;
  const boxName = (boxId: string | undefined) => deps.registry.listBoxes().find(box => box.id === boxId)?.name ?? boxId ?? "";
  const view = () => {
    const shared = deps.registry.readSharedMemory();
    return {
      on: teamReviewOn(),
      pending: pendingReviews(shared).map(item => ({
        writer: item.writer,
        writerName: nameOf(item.writer),
        version: item.version,
        text: item.record.text,
        at: item.record.at,
        kind: item.record.kind,
        audience: item.record.audience === "everyone" ? "everyone" : "box",
        boxName: boxName(item.record.box),
      })),
      everyone: memoryView(shared)
        .filter(line => line.status === "live" && line.audience === "everyone")
        .map(line => ({ writerName: nameOf(line.via ?? ""), boxName: boxName(line.box), text: line.text, at: line.at })),
    };
  };
  if (route === "GET /api/memory/team-review") return { status: 200, body: view() };
  const body = await deps.readJson();
  if (route === "POST /api/memory/team-review/setting") {
    if (typeof body.on !== "boolean") return { status: 400, body: apiError("memory-review-on") };
    saveConfig({ teamMemoryReview: body.on });
    deps.log(`team memory review turned ${body.on ? "on" : "off"} by ${deps.by()}`);
    return { status: 200, body: view() };
  }
  if (route === "POST /api/memory/team-review/decide") {
    const decision = body.decision === "approved" || body.decision === "rejected" ? body.decision : undefined;
    if (decision === undefined) return { status: 400, body: apiError("memory-review-decision") };
    const result = decideReview(deps.registry, String(body.writer ?? ""), String(body.version ?? ""), decision, deps.by());
    if (!result.ok) return { status: 409, body: { error: result.why, ...view() } };
    deps.log(`team memory: ${deps.by()} ${decision} a write by ${String(body.writer)}`);
    return { status: 200, body: view() };
  }
  return { status: 404, body: apiError("route-unknown", { route }) };
}
