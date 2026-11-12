import type { DeliveryRecovery, RecoveryView } from "../host/delivery-recovery.ts";
import { apiError } from "./api-error.ts";

export async function deliveryRecoveryRoute(route: string, url: URL, deps: { recovery: DeliveryRecovery; refused: () => boolean; readJson: () => Promise<Record<string, unknown>>; mayRead: (row: Pick<RecoveryView, "agentId" | "taskId">) => boolean; by: string }) {
  if (route !== "GET /api/deliveries/recovery" && route !== "POST /api/deliveries/recovery") return undefined;
  if (deps.refused()) return { status: 0, body: {} };
  try {
    if (route.startsWith("GET")) {
      const id = url.searchParams.get("id");
      if (!id) return { status: 200, body: { replies: deps.recovery.list(Number(url.searchParams.get("limit") ?? 50), Number(url.searchParams.get("offset") ?? 0), deps.mayRead) } };
      const row = deps.recovery.preview(id);
      return row && deps.mayRead(row) ? { status: 200, body: { reply: row } } : { status: 404, body: apiError("delivery-unknown") };
    }
    const body = await deps.readJson(), id = String(body.id ?? ""), token = String(body.token ?? "");
    const row = deps.recovery.preview(id);
    if (!row || !deps.mayRead(row)) return { status: 404, body: apiError("delivery-unknown") };
    if (body.action !== "discard" && body.action !== "send") return { status: 400, body: apiError("delivery-action") };
    const reply = body.action === "discard" ? deps.recovery.discard(id, token, deps.by) : await deps.recovery.send(id, token, deps.by);
    return { status: 200, body: { reply } };
  } catch (error) { return { status: 409, body: apiError("delivery-refused", { reason: error instanceof Error ? error.message : "unavailable" }) }; }
}
