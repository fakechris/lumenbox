/**
 * The Owner-to-Admin conversion (INV-1685, docs/22 §1a): the one route that turns a single-machine
 * installation into an organisation. Only an explicit `confirm: true` from an admin converts; the
 * page sends it after a person pressed the dialog's button, never on its own.
 */
import { convertToOrganisation, OwnerConversionRequired } from "../host/installation.ts";
import type { Principals } from "../host/principals.ts";

export async function installationRoute(
  route: string,
  deps: { path: string; principals: Principals; readJson: () => Promise<Record<string, unknown>>; refusedAdmin: () => boolean; by: () => string; log: (line: string) => void }
): Promise<{ status: number; body: unknown } | undefined> {
  if (route === "GET /api/installation") return { status: 200, body: { installation: deps.principals.installation() } };
  if (route !== "POST /api/installation/convert") return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: undefined };
  const body = await deps.readJson();
  if (body.confirm !== true) return { status: 400, body: { error: "Converting needs confirm: true — a person's explicit yes in the dialog." } };
  const by = deps.by();
  const converted = convertToOrganisation(deps.path, by);
  deps.principals.reload();
  if (converted) deps.log(`installation converted: single-machine → organisation, confirmed by ${by}; the Owner is now an Admin (INV-1685)`);
  return { status: 200, body: { converted, installation: deps.principals.installation() } };
}

/** The status and extra body fields for an error a route threw: 409 with `needs` when the roster asks for the conversion first. */
export function routeErrorReply(error: unknown): { status?: number; needs?: string } {
  return error instanceof OwnerConversionRequired ? { status: 409, needs: error.needs } : {};
}
