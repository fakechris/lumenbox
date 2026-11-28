/**
 * The OpenAPI 3.1 document of `/api/v1`, built from `schema.ts` and nothing else (docs/106 §4.1).
 * `docs/api/v1.openapi.json` is this function's output, written by
 * `node scripts/surface-ratchet.mjs --write-baseline`; `npm run arch` fails when the file and the
 * function disagree, and when the operations, fields or known values it holds lose anything.
 */

import { API_PREFIX, API_VERSION, CONVENTIONS, ERRORS, OPERATIONS, SCHEMAS, SCOPES, commonErrors, type ApiErrorCode, type Operation, type Param } from "./schema.ts";

type Json = Record<string, unknown>;

const errorBody = { "application/json": { schema: { $ref: "#/components/schemas/Error" } } };
const requestIdHeader = { "X-Request-Id": { description: "Names this request in the server's log.", schema: { type: "string" } } };

/** One response per status, listing every code it may carry: what a contract test answers for one by one. */
function errorResponses(codes: readonly ApiErrorCode[]): Json {
  const byStatus = new Map<number, ApiErrorCode[]>();
  for (const code of codes) byStatus.set(ERRORS[code].status, [...(byStatus.get(ERRORS[code].status) ?? []), code]);
  const out: Json = {};
  for (const [status, list] of [...byStatus].sort(([a], [b]) => a - b)) {
    out[String(status)] = {
      description: list.map(code => `\`${code}\`: ${ERRORS[code].meaning}`).join("\n"),
      "x-error-codes": list,
      headers: status === 429 ? { ...requestIdHeader, "Retry-After": { description: "Seconds to wait.", schema: { type: "integer" } } } : requestIdHeader,
      content: errorBody,
    };
  }
  return out;
}

function parameter(where: "path" | "query", param: Param): Json {
  return { name: param.name, in: where, required: where === "path" || param.required === true, description: param.description, schema: param.schema };
}

function operationOf(operation: Operation): Json {
  const params = [
    ...(operation.pathParams ?? []).map(param => parameter("path", param)),
    ...(operation.query ?? []).map(param => parameter("query", param)),
    ...(operation.stream === true ? [{ name: "Last-Event-ID", in: "header", required: false, description: "The `id` of the last event this client read: the stream replays what changed since.", schema: { type: "string" } }] : []),
    ...(operation.method === "GET" && operation.stream !== true ? [{ name: "If-None-Match", in: "header", required: false, description: "An `ETag` this client holds: 304 when it still matches.", schema: { type: "string" } }] : []),
    ...(operation.method === "POST" ? [{
      name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" },
      description: operation.secret === true
        ? "A key the client keeps for this request: a repeat within 30 seconds answers the first answer (held in memory only: the answer holds a token)."
        : "A key the client keeps for this request: a repeat within 24 hours answers the first answer.",
    }] : []),
  ];
  const scope = operation.scope === undefined ? (operation.auth === "none" ? "No credential needed." : "Any credential.") : `Scope \`${operation.scope}\`.`;
  return {
    operationId: operation.operationId,
    summary: operation.summary,
    description: `${operation.description}\n\n${scope}`,
    tags: [operation.tier === "preview" ? "preview" : "stable"],
    security: operation.auth === "none" ? [] : [{ bearer: [] }],
    "x-scope": operation.scope ?? (operation.auth === "none" ? "none" : "any"),
    "x-tier": operation.tier,
    ...(params.length > 0 ? { parameters: params } : {}),
    ...(operation.requestBody !== undefined ? { requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${operation.requestBody}` } } } } } : {}),
    ...(operation.secret === true ? { "x-secret-answer": true } : {}),
    responses: {
      200: operation.stream === true ? {
        description: `Server-sent events; each \`change\` event's data is a \`${operation.response}\`.`,
        headers: requestIdHeader,
        content: { "text/event-stream": { schema: { type: "string" } } },
        "x-event-data": { $ref: `#/components/schemas/${operation.response}` },
      } : {
        description: SCHEMAS[operation.response].description,
        headers: {
          ...requestIdHeader, ...(operation.method === "GET" ? { ETag: { description: "Send it back as `If-None-Match`.", schema: { type: "string" } } } : {}),
          ...(operation.secret === true ? { "Cache-Control": { description: "`no-store`: the answer holds a token.", schema: { type: "string" } } } : {}),
        },
        content: { "application/json": { schema: { $ref: `#/components/schemas/${operation.response}` } } },
      },
      ...(operation.method === "GET" && operation.stream !== true ? { 304: { description: "Unchanged since the `ETag` in `If-None-Match`.", headers: requestIdHeader } } : {}),
      ...errorResponses(commonErrors(operation)),
    },
  };
}

/** The whole document, deterministic: the same schema gives the same bytes. */
export function openApiDocument(): Json {
  const paths: Json = {};
  for (const operation of OPERATIONS) {
    const path = `${API_PREFIX}${operation.path}`;
    paths[path] = { ...(paths[path] as Json | undefined), [operation.method.toLowerCase()]: operationOf(operation) };
  }
  return {
    openapi: "3.1.0",
    info: { title: "LumenBox client API", version: API_VERSION, description: CONVENTIONS, license: { name: "GPL-3.0-only", identifier: "GPL-3.0-only" } },
    tags: [{ name: "stable", description: "Changes by addition only inside v1 (docs/106 §1)." }, { name: "preview", description: "May change in any release; listed in `meta.preview`." }],
    paths,
    components: {
      securitySchemes: {
        bearer: {
          type: "http", scheme: "bearer",
          description: `A personal token (\`lbxp_…\`), a service token (\`lbxs_…\`) or a device's access token (\`lbxd_…\`). Scopes:\n${Object.entries(SCOPES).map(([scope, what]) => `- \`${scope}\`: ${what}`).join("\n")}`,
        },
      },
      schemas: SCHEMAS,
    },
  };
}

/** The file's text: two-space JSON and a newline, as the repository writes JSON. */
export function openApiText(): string {
  return `${JSON.stringify(openApiDocument(), null, 2)}\n`;
}
