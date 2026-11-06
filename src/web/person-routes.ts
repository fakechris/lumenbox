/** The person's own record (INV-1653), read and edited from Settings → Mine: the caller's, or the operator's when nobody is signed in. */

import { isPersonField, OPERATOR, PERSON_FIELDS, type PersonRecords } from "../host/person.ts";

export async function personRoute(
  route: string,
  people: PersonRecords,
  deps: { readJson: () => Promise<Record<string, unknown>>; caller: () => { id: string; name: string } | undefined }
): Promise<{ status: number; body: unknown } | undefined> {
  if (!route.endsWith(" /api/person") && route !== "POST /api/person/retract") return undefined;
  const who = deps.caller();
  const principal = who?.id ?? OPERATOR;
  const view = () => ({ principal, name: who?.name ?? "the operator", fields: [...PERSON_FIELDS], entries: people.live(principal), rendered: people.render(principal, who?.name ?? "the operator") ?? "" });
  if (route === "GET /api/person") return { status: 200, body: view() };
  const body = await deps.readJson();
  if (route === "POST /api/person/retract") {
    if (!people.retract(principal, String(body.id ?? ""), who?.id ?? "operator")) return { status: 404, body: { error: "No such line" } };
    return { status: 200, body: view() };
  }
  if (!isPersonField(body.field)) return { status: 400, body: { error: `field must be one of ${PERSON_FIELDS.join(", ")}` } };
  const expiresAt = typeof body.expiresAt === "string" && !Number.isNaN(Date.parse(body.expiresAt)) ? new Date(body.expiresAt).toISOString() : undefined;
  const entry = people.add(principal, { field: body.field, text: String(body.text ?? ""), source: "person", ...(expiresAt !== undefined ? { expiresAt } : {}) });
  if (entry === undefined) return { status: 400, body: { error: "Nothing to add: empty, or already on the record" } };
  return { status: 200, body: view() };
}
