/**
 * Vault values out of the record and out of model requests (INV-1186, roadmap R7).
 *
 * Exact-value replacement only. docs/15 measured pattern detection on our own records and
 * found it 0% precise, so nothing here guesses what a credential looks like: a value is
 * replaced because the vault holds it, and for no other reason.
 *
 * This is hygiene, not containment (docs/15 §"The review came back"). A value that is
 * base64'd, split, reversed or typed back with a space in it passes straight through.
 * What it does buy: an exact copy of a held secret — a `RunOnHost` that printed its token,
 * a page that echoed an API key, a `.env` an agent read — does not land in the transcript
 * in clear and is not sent back to the provider on the next request.
 *
 * Rules, each for a reason:
 * - Longest value first, so a secret that contains another is replaced whole.
 * - The JSON-escaped form is replaced too: a value with a quote or backslash in it appears
 *   escaped inside any tool result that carried JSON.
 * - A value shorter than WHOLE_VALUE (a PIN, a short password) is replaced only where no
 *   letter or digit touches it, and an all-digit one also not inside a date, time, version
 *   or path. "2026" as a PIN must not eat the year out of every date.
 * - Below MIN_VALUE nothing is replaced: three characters match too much to mean anything.
 * - Replacement is structural. Only text a model or a person wrote is rewritten — ids,
 *   names, roles, types, timestamps and signed or opaque blocks are left byte-for-byte, so
 *   tool_use / tool_result pairing and thinking signatures survive.
 *
 * The table is deterministic for a given vault state, so the same history redacts to the
 * same bytes on every request and the provider's prefix cache still holds.
 */

import { createHash } from "node:crypto";

export const MIN_VALUE = 4;
export const WHOLE_VALUE = 12;

/** One value to hide and the name it is replaced with. */
export interface RedactionEntry {
  name: string;
  value: string;
}

export interface Redactor {
  /** Replaces every held value in one string. Returns the same string when nothing matched. */
  text(input: string): string;
  /** A structural copy of a record or request with only its prose rewritten. */
  deep<T>(value: T): T;
  /** True when there is nothing to hide, so callers can skip the walk. */
  readonly empty: boolean;
  /** Stable for a given set of values; changes when the vault does. */
  readonly version: string;
}

const label = (name: string): string => `[secret:${name}]`;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Keys whose string values are identifiers, enums or machine data, never prose. A secret
 * that happened to equal one of these would be a coincidence; rewriting it would break the
 * record (an orphaned tool_result, a thinking block that no longer verifies).
 */
const STRUCTURAL_KEYS = new Set([
  "id",
  "tool_use_id",
  "toolUseId",
  "type",
  "role",
  "name",
  "at",
  "turnId",
  "workId",
  "agentId",
  "conversation",
  "model",
  "media_type",
  "signature",
  "data",
  "stop_reason",
  "cache_control",
]);

/** Blocks that are signed or opaque: altering a byte invalidates them. */
const OPAQUE_BLOCK_TYPES = new Set(["thinking", "redacted_thinking", "image", "document"]);

/**
 * Where a short value counts as itself. A word-like value must not touch a letter or digit.
 * An all-digit value (a PIN) must not sit inside a date, a time, a version or a path either:
 * "2026" is a PIN in "PIN 2026" and a year in "2026-10-14".
 */
function shortValuePattern(find: string): RegExp {
  const body = escapeRegExp(find);
  return /^\d+$/.test(find)
    ? new RegExp(`(?<![\\p{L}\\p{N}\\-:/.])${body}(?![\\p{L}\\p{N}\\-:/]|\\.\\p{N})`, "gu")
    : new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "gu");
}

export function buildRedactor(entries: readonly RedactionEntry[]): Redactor {
  const pairs: { find: string; replace: string; short: boolean }[] = [];
  const seen = new Set<string>();
  for (const { name, value } of entries) {
    if (typeof value !== "string" || value.length < MIN_VALUE) continue;
    for (const form of [value, JSON.stringify(value).slice(1, -1)]) {
      if (seen.has(form)) continue;
      seen.add(form);
      pairs.push({ find: form, replace: label(name), short: value.length < WHOLE_VALUE });
    }
  }
  pairs.sort((a, b) => b.find.length - a.find.length || (a.find < b.find ? -1 : a.find > b.find ? 1 : 0));
  const patterns = pairs.map(pair => ({
    ...pair,
    regex: pair.short ? shortValuePattern(pair.find) : undefined,
  }));
  const version = createHash("sha256").update(pairs.map(pair => `${pair.replace}\u0000${pair.find}`).join("\u0001")).digest("hex").slice(0, 16);

  const text = (input: string): string => {
    if (patterns.length === 0 || input === "") return input;
    let out = input;
    for (const pattern of patterns) {
      if (!out.includes(pattern.find)) continue;
      out = pattern.regex === undefined ? out.split(pattern.find).join(pattern.replace) : out.replace(pattern.regex, pattern.replace);
    }
    return out;
  };

  const walk = (value: unknown, key?: string): unknown => {
    if (typeof value === "string") return key !== undefined && STRUCTURAL_KEYS.has(key) ? value : text(value);
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map(item => {
        const out = walk(item);
        if (out !== item) changed = true;
        return out;
      });
      return changed ? next : value;
    }
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (typeof record.type === "string" && OPAQUE_BLOCK_TYPES.has(record.type)) return value;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      const out = walk(v, k);
      if (out !== v) changed = true;
      next[k] = out;
    }
    return changed ? next : value;
  };

  return {
    text,
    deep: <T>(value: T): T => (patterns.length === 0 ? value : (walk(value) as T)),
    empty: patterns.length === 0,
    version,
  };
}

const NONE = buildRedactor([]);

/**
 * The process-wide source of held values, registered by whoever owns the vault (the web
 * server). Unregistered — tests, the CLI, a host with no vault — means nothing to hide.
 * A function rather than a list so a value saved a second ago is hidden on the next write.
 */
let source: (() => readonly RedactionEntry[]) | undefined;
let cached: { key: string; redactor: Redactor } | undefined;

export function setRedactionSource(next: (() => readonly RedactionEntry[]) | undefined): void {
  source = next;
  cached = undefined;
}

/** The redactor for the vault as it is now; rebuilt only when the held values change. */
export function currentRedactor(): Redactor {
  if (source === undefined) return NONE;
  let entries: readonly RedactionEntry[];
  try {
    entries = source();
  } catch {
    // A vault that cannot be read hides nothing rather than stopping every write.
    return NONE;
  }
  const key = entries.map(entry => `${entry.name}\u0000${entry.value}`).join("\u0001");
  if (cached?.key !== key) cached = { key, redactor: buildRedactor(entries) };
  return cached.redactor;
}

/** Shorthands for the write sites. */
export const redactText = (input: string): string => currentRedactor().text(input);
export const redactDeep = <T>(value: T): T => currentRedactor().deep(value);
