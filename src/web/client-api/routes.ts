/**
 * The route table of `/api/v1`, pure (docs/106 §4.1): every allowed method and path is an
 * operation in `schema.ts`, and anything else is refused here, before any credential is read or
 * any handler runs. A path no operation has answers 404; a path one has, with another method, 405.
 *
 * Request validation is here too, from the same declarations: a parameter the operation does not
 * declare is refused, and a declared one is checked against its schema before a handler sees it.
 */

import { API_PREFIX, OPERATIONS, SCHEMAS, type Operation, type Param, type Schema } from "./schema.ts";

export type Match =
  | { kind: "operation"; operation: Operation; pathParams: Record<string, string> }
  | { kind: "unknown" }
  | { kind: "method"; allowed: string[] }
  | { kind: "malformed"; name: string };

/** `/api/v1/work/{id}` against `/api/v1/work/t12`: the parameters, or undefined when the path is another. */
function matchPath(template: string, segments: readonly string[]): Record<string, string> | "malformed" | undefined {
  const parts = template.split("/").filter(Boolean);
  if (parts.length !== segments.length) return undefined;
  const params: Record<string, string> = {};
  for (let at = 0; at < parts.length; at += 1) {
    const part = parts[at]!, segment = segments[at]!;
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    if (name === undefined) { if (part !== segment) return undefined; continue; }
    try { params[name] = decodeURIComponent(segment); } catch { return "malformed"; }
    if (params[name] === "") return undefined;
  }
  return params;
}

/** Which operation a request is, or why it is none. `pathname` is the whole path, prefix included. */
export function matchRoute(method: string, pathname: string, operations: readonly Operation[] = OPERATIONS): Match {
  if (pathname !== API_PREFIX && !pathname.startsWith(`${API_PREFIX}/`)) return { kind: "unknown" };
  const segments = pathname.slice(API_PREFIX.length).split("/").filter(Boolean);
  const allowed: string[] = [];
  for (const operation of operations) {
    const params = matchPath(operation.path, segments);
    if (params === undefined) continue;
    if (operation.method !== method) { allowed.push(operation.method); continue; }
    if (params === "malformed") return { kind: "malformed", name: /\{(\w+)\}/.exec(operation.path)?.[1] ?? "path" };
    return { kind: "operation", operation, pathParams: params };
  }
  return allowed.length > 0 ? { kind: "method", allowed: [...new Set(allowed)] } : { kind: "unknown" };
}

export type Refusal = { code: "api-param-invalid" | "api-param-unknown"; vars: { name: string; why?: string } };
export type ParamValue = string | number | boolean;

/** One parameter's text as its schema's value, or why not. */
function parse(param: Param, raw: string): ParamValue | Refusal {
  const invalid = (why: string): Refusal => ({ code: "api-param-invalid", vars: { name: param.name, why } });
  const schema = param.schema;
  if (schema.type === "integer") {
    if (!/^-?\d{1,16}$/.test(raw)) return invalid("a whole number");
    const value = Number(raw);
    if (schema.minimum !== undefined && value < schema.minimum) return invalid(`at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) return invalid(`at most ${schema.maximum}`);
    return value;
  }
  if (schema.type === "boolean") return raw === "true" ? true : raw === "false" ? false : invalid("true or false");
  if (schema.maxLength !== undefined && raw.length > schema.maxLength) return invalid(`at most ${schema.maxLength} characters`);
  if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(raw)) return invalid(`of the form ${schema.pattern}`);
  const values = schema["x-extensible-enum"];
  if (values !== undefined && !values.includes(raw)) return invalid(`one of ${values.join(", ")}`);
  return raw;
}

const isRefusal = (value: unknown): value is Refusal => typeof value === "object" && value !== null && "code" in value;

/** The operation's parameters from the request, checked: values by name, or the first refusal. */
export function readParams(operation: Operation, pathParams: Record<string, string>, query: URLSearchParams): { values: Record<string, ParamValue> } | Refusal {
  const values: Record<string, ParamValue> = {};
  for (const param of operation.pathParams ?? []) {
    const value = parse(param, pathParams[param.name] ?? "");
    if (isRefusal(value)) return value;
    values[param.name] = value;
  }
  const declared = new Map((operation.query ?? []).map(param => [param.name, param]));
  for (const name of new Set(query.keys())) {
    const param = declared.get(name);
    if (param === undefined) return { code: "api-param-unknown", vars: { name } };
    const all = query.getAll(name);
    if (all.length > 1) return { code: "api-param-invalid", vars: { name, why: "given once" } };
    const value = parse(param, all[0]!);
    if (isRefusal(value)) return value;
    values[name] = value;
  }
  for (const param of operation.query ?? []) if (param.required === true && values[param.name] === undefined) return { code: "api-param-invalid", vars: { name: param.name, why: "required" } };
  return { values };
}

// --- checking a body against the schema (the contract tests, and nothing at run time) ------------

function resolve(schema: Schema): Schema {
  if (schema.$ref === undefined) return schema;
  const name = schema.$ref.replace("#/components/schemas/", "") as keyof typeof SCHEMAS;
  return SCHEMAS[name] as Schema;
}

/**
 * What is wrong with `value` as an instance of `schema`, as sentences; empty when nothing is.
 * `strict` is the server's side of the contract: no field the schema does not declare, and no
 * value of an open enumeration that it does not list — what this server sends, it documents.
 */
export function problemsOf(value: unknown, schema: Schema, strict = true, at = "$"): string[] {
  const shape = resolve(schema);
  const problems: string[] = [];
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : Number.isInteger(value) ? "integer" : typeof value;
  if (shape.type !== undefined && kind !== shape.type && !(shape.type === "object" && kind === "object")) return [`${at}: ${kind}, not ${shape.type}`];
  if (shape.type === "string") {
    if (shape.format === "date-time" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value as string)) problems.push(`${at}: not an RFC 3339 UTC time to the second`);
    const values = shape["x-extensible-enum"];
    if (strict && values !== undefined && !values.includes(value as string)) problems.push(`${at}: "${String(value)}" is not a known value`);
  }
  if (shape.type === "array") for (const [index, item] of (value as unknown[]).entries()) problems.push(...problemsOf(item, shape.items ?? {}, strict, `${at}[${index}]`));
  if (shape.type === "object") {
    const record = value as Record<string, unknown>;
    for (const field of shape.required ?? []) if (record[field] === undefined) problems.push(`${at}.${field}: required and absent`);
    for (const [field, item] of Object.entries(record)) {
      const declared = shape.properties?.[field];
      if (declared === undefined) { if (strict) problems.push(`${at}.${field}: not in the schema`); continue; }
      if (item === null) { problems.push(`${at}.${field}: null (absent, never null)`); continue; }
      problems.push(...problemsOf(item, declared, strict, `${at}.${field}`));
    }
  }
  return problems;
}
