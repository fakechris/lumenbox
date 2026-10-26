/**
 * The guard every memory writer runs (INV-1333): what may not be written, however it is dressed.
 *
 * INV-740 refused a credential in clear. Three things got past that, each a way of saying the same
 * secret differently: the value base64- or percent-encoded, the value with spaces in it, and a
 * candidate carrying an invisible character that makes a later exact match fail. A fourth is not a
 * secret but is just as much not a memory: an identifier the person pasted this turn, copied into a
 * "fact" verbatim — that is a restatement of input, and memory is read into every future turn.
 *
 * The guard refuses and says why, by kind. It never rewrites: a memory altered on the way in is a
 * memory nobody said, and a refusal that quotes the offending characters has written them. The
 * design is borrowed from a learning store whose rule is "refuse, never redact" (research 2026-10-23).
 */
import { CREDENTIAL_PATTERNS, credentialIn, credentialRefusal, MIN_EXACT_LENGTH } from "./secret-scan.ts";

export interface GuardInput {
  /** Values this installation holds (vault, configured tokens), by name. Compared, never printed. */
  held?: ReadonlyMap<string, string>;
  /** What was said this turn, so an identifier copied out of it is recognised as a restatement. */
  spoken?: string;
}

/** Zero-width, bidi-control, tag and soft-hyphen characters: invisible, and a classic way to smuggle. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u;
/** A run that may be base64: long enough that prose never matches by accident. */
const BASE64_RUN = /[A-Za-z0-9+/_-]{24,}={0,2}/g;
/** An identifier: long, mixed letters and digits, no spaces. Hex alone is left out (a commit sha is a fact). */
const IDENTIFIER = /[A-Za-z0-9_-]{20,}/g;

/** Decoded bytes that read as text: no control characters besides tab, newline and return. */
function readable(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
  }
  return true;
}

/** The text in every encoding a secret might hide behind, plus the text itself first. */
function variants(text: string): string[] {
  const out = [text, text.replace(/\s+/g, "")];
  try {
    const decoded = decodeURIComponent(text);
    if (decoded !== text) out.push(decoded);
  } catch {
    // Not percent-encoded; nothing to add.
  }
  for (const match of text.matchAll(BASE64_RUN)) {
    const run = match[0].replace(/-/g, "+").replace(/_/g, "/");
    try {
      const decoded = Buffer.from(run, "base64").toString("utf8");
      // Only text that decodes to something readable is worth scanning; binary noise would match nothing anyway.
      if (decoded.length >= 8 && readable(decoded)) out.push(decoded);
    } catch {
      // Not base64.
    }
  }
  return out;
}

/** The encodings a held value might appear in, so `includes` catches the dressed-up copy too. */
export function encodings(value: string): string[] {
  return [
    value,
    value.replace(/\s+/g, ""),
    Buffer.from(value, "utf8").toString("base64"),
    Buffer.from(value, "utf8").toString("base64url"),
    encodeURIComponent(value),
  ];
}

function isIdentifier(token: string): boolean {
  return /[A-Za-z]/.test(token) && /\d/.test(token) && !/^[0-9a-f]+$/i.test(token);
}

/**
 * Why a candidate may not be written, or undefined. The reason names the kind of thing found and
 * never any of its characters.
 */
export type GuardKind = "invisible" | "credential" | "held" | "restatement";

export function guardMemoryCandidate(text: string, input: GuardInput = {}): { kind: GuardKind; reason: string; pattern?: string } | undefined {
  if (INVISIBLE.test(text)) {
    return { kind: "invisible", reason: "That carries invisible characters (zero-width, bidirectional or tag characters). A memory is plain text; write it without them." };
  }
  for (const variant of variants(text)) {
    const credential = credentialIn(variant);
    if (credential !== undefined) return { kind: "credential", pattern: credential, reason: credentialRefusal("A memory", credential) };
  }
  if (input.held !== undefined) {
    const variantsOfText = variants(text);
    for (const [name, value] of input.held) {
      if (value.length < MIN_EXACT_LENGTH) continue;
      const forms = encodings(value);
      if (variantsOfText.some(variant => forms.some(form => variant.includes(form)))) {
        return { kind: "held", reason: `That holds the value of ${name}, in clear or encoded. A memory never carries a held value — say where it lives instead.` };
      }
    }
  }
  if (input.spoken !== undefined && input.spoken !== "") {
    for (const match of input.spoken.matchAll(IDENTIFIER)) {
      const token = match[0];
      if (!isIdentifier(token)) continue;
      if (text.includes(token)) {
        return { kind: "restatement", reason: "That copies an identifier out of this conversation verbatim. Keep what it is for and where to find it, not the identifier itself." };
      }
    }
  }
  return undefined;
}

/** For tests and the documentation: the credential shapes the guard knows, by name. */
export function guardedCredentialKinds(): readonly string[] {
  return CREDENTIAL_PATTERNS.map(entry => entry.name);
}
