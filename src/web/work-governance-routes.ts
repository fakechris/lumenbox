import { apiError } from "./api-error.ts";
import type {
  WorkGovernance,
  GovernanceAdapter,
  GovernanceAction,
} from "../host/work-governance.ts";
export async function governanceRoute(
  route: string,
  url: URL,
  deps: {
    service: WorkGovernance;
    adapter: () => GovernanceAdapter;
    refused: () => boolean;
    readJson: () => Promise<Record<string, unknown>>;
    by: string;
  },
) {
  if (
    ![
      "GET /api/work-management", "GET /api/work-management/operation",
      "POST /api/work-management/preview",
      "POST /api/work-management/apply",
    ].includes(route)
  )
    return undefined;
  if (deps.refused()) return { status: 0, body: {} };
  try {
    const adapter = deps.adapter();
    if (route === "GET /api/work-management/operation") return { status: 200, body: deps.service.operation(adapter, url.searchParams.get("id") ?? "", deps.by) };
    if (route.startsWith("GET"))
      return {
        status: 200,
        body: await deps.service.list(adapter, {
          section: url.searchParams.get("section") ?? undefined,
          search: url.searchParams.get("search")?.slice(0, 200),
          offset: Number(url.searchParams.get("offset") ?? 0),
          limit: 50,
          archive: url.searchParams.get("archive") === "1",
        }),
      };
    const body = await deps.readJson();
    if (route.endsWith("preview"))
      return {
        status: 200,
        body: await deps.service.preview(
          adapter,
          body.choices as { key: string; action: GovernanceAction }[],
        ),
      };
    return {
      status: 200,
      body: await deps.service.execute(
        adapter,
        {
          token: String(body.token ?? ""),
          operationId: String(body.operationId ?? ""),
        },
        deps.by,
      ),
    };
  } catch (error) {
    return { status: 409, body: apiError("work-management-refused", { reason: error instanceof Error ? error.message : "unavailable" }) };
  }
}
