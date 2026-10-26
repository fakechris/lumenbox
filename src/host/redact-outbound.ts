/**
 * Held values never leave on the stream or the trace (INV-1360).
 *
 * A vault value a tool was handed can come back in its output. The record is protected
 * (`recordAs`, docs/15): the transcript keeps "ran with SHOP_PASSWORD in its environment" and
 * not the output. But the same words still travel two other ways — the `text` and `interim`
 * events the web page, the channel's streaming card and the activity feed read, and the reply a
 * channel delivers — and nothing scrubbed those. HarnessRouter's `env_secret` redaction covers
 * the response, the stream, the trace and the record alike (research 2026-10-25); this closes
 * the two we were missing.
 *
 * The rule is the memory guard's (INV-1333): a held value is matched in clear and in the
 * encodings a model is likely to repeat it in — base64, base64url, percent-encoded, spaces
 * removed — and only when it is long enough that prose cannot match it by accident. What stands
 * in its place names the secret, never any of its characters: `[vault:SHOP_PASSWORD]`.
 *
 * Outbound only. The model keeps seeing the tool result it was given, because it already did;
 * the record keeps `recordAs`. This is the last door, not a new one.
 */

import { encodings } from "./memory-guard.ts";
import { MIN_EXACT_LENGTH } from "./secret-scan.ts";

export type Redactor = (text: string) => string;

/** A redactor over the values held now. Built once per turn; cheap to call per event. */
export function outboundRedactor(held: ReadonlyMap<string, string> | undefined): Redactor {
  if (held === undefined || held.size === 0) return text => text;
  const forms: { form: string; stand: string }[] = [];
  for (const [name, value] of held) {
    if (typeof value !== "string" || value.length < MIN_EXACT_LENGTH) continue;
    for (const form of new Set(encodings(value))) {
      if (form.length >= MIN_EXACT_LENGTH) forms.push({ form, stand: `[vault:${name}]` });
    }
  }
  // Longest first, so a value that contains another is replaced whole.
  forms.sort((a, b) => b.form.length - a.form.length);
  if (forms.length === 0) return text => text;
  return text => {
    if (text === "") return text;
    let out = text;
    for (const { form, stand } of forms) if (out.includes(form)) out = out.split(form).join(stand);
    return out;
  };
}

/** The events that carry words to a person; everything else passes untouched. */
export function redactEvent<T extends { type: string }>(event: T, redact: Redactor): T {
  const typed = event as { type: string; delta?: string; text?: string };
  if (typed.type === "text" && typeof typed.delta === "string") return { ...event, delta: redact(typed.delta) };
  if (typed.type === "interim" && typeof typed.text === "string") return { ...event, text: redact(typed.text) };
  return event;
}
