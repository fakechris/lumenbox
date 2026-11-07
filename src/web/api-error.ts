/**
 * A refusal a route answers with (INV-1686): a stable `code` for a program, and `error` in the
 * words of the person who asked.
 *
 * A route builds the body with `apiError(code, vars)`; the words are English until the body is
 * sent, and `send` puts them in the request's language (`localizedBody`), chosen the way the page
 * is (`?lang=`, the `lumen-lang` cookie, the browser, then the default). So a route needs no
 * locale, a route module that returns `{ status, body }` needs none either, and a test that calls
 * one directly reads English. What reads a reply as a program matches on `code`, never on the
 * words: they differ per reader and change with every edit to `src/i18n/server-errors.ts`.
 */

import type { IncomingMessage } from "node:http";
import { tr } from "../i18n/messages.ts";
import type { ErrorCode } from "../i18n/server-errors.ts";
import { requestLocaleOf } from "./page-locale.ts";

type Vars = Record<string, string | number>;

/** Where a body keeps its blanks until it is sent; a symbol, so it never reaches the JSON. */
const VARS = Symbol("api-error-vars");

export interface ApiError {
  code: ErrorCode;
  error: string;
  [VARS]: Vars;
}

export function apiError(code: ErrorCode, vars: Vars = {}): ApiError {
  return { code, error: tr(`err.${code}`, "en", vars), [VARS]: vars };
}

/** The body as its reader reads it: an `apiError` (or an object spread from one) in the request's language. */
export function localizedBody(body: unknown, req: IncomingMessage | undefined): unknown {
  if (req === undefined || typeof body !== "object" || body === null || !(VARS in body)) return body;
  const refusal = body as ApiError;
  return { ...refusal, error: tr(`err.${refusal.code}`, requestLocaleOf(req), refusal[VARS]) };
}
