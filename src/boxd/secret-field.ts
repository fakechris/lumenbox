/** Where a vault secret may be typed (INV-402, INV-1380): host binding, field shape, submit targets. */

/**
 * Whether a page's host is one a secret may be typed into: exact, or `*.example.com`
 * for the domain and its subdomains. An empty list allows nothing — a credential with no
 * home is fillable nowhere.
 */
export function hostAllowed(host: string, domains: readonly string[]): boolean {
  const target = host.trim().toLowerCase();
  if (target === "") return false;
  return domains.some(entry => {
    const pattern = entry.trim().toLowerCase();
    if (pattern === "") return false;
    if (pattern.startsWith("*.")) {
      const bare = pattern.slice(2);
      return target === bare || target.endsWith(`.${bare}`);
    }
    return target === pattern;
  });
}

/** What a field says about itself, read in the isolated world before a secret goes into it. */
export interface SecretField {
  /** Lower-case tag name. */
  tag: string;
  /** The input's `type`, lower-case; empty for anything that is not an input. */
  type: string;
  /** The owning form's `method` (`get`, `post`, `dialog`), or undefined when the field has no form. */
  formMethod?: string;
  /** Each submitter's `formmethod` override, lower-case: a button can turn a POST form into a GET. */
  submitMethods?: readonly string[];
  /** False when the field belongs to no form; absent from older readers. */
  hasForm?: boolean;
  /**
   * Every URL the owning form could submit to, resolved: the form's `action` and each submitter's
   * `formaction`. Empty when the field has no form.
   */
  submitTargets: readonly string[];
}

/** A host on this machine: nothing between here and there to read cleartext, nobody to hand data to. */
export function loopback(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127\./.test(bare) || bare.endsWith(".localhost");
}

/** Input types a credential is typed into. `search` is not one: its value becomes a URL. */
const SECRET_INPUT_TYPES = new Set(["password", "text", "email", "tel", "number"]);

/**
 * Why a secret may not go into this field, or undefined when it may.
 *
 * The page's host is checked separately (`hostAllowed`); this is the rest of the binding. A host
 * match alone lets a secret be typed into a comment box on the right site and posted for anyone
 * to read, or into a login form whose `action` sends it somewhere else. So: a single-line input
 * of a credential type, in no form or a form that posts, and every place that form can submit
 * to is a host the secret names. Script-driven submission (`fetch` from the page) is outside
 * what a field can tell us; docs/49 lists it as a bypass surface.
 */
export function secretFieldRefusal(field: SecretField, domains: readonly string[]): string | undefined {
  if (field.tag !== "input") {
    return `That element is a ${field.tag || "non-field"}; a secret is filled only into a single-line input, never a text area or editable region whose content gets posted.`;
  }
  if (!SECRET_INPUT_TYPES.has(field.type)) {
    return `That input is type="${field.type}"; a secret is filled only into a password, text, email, tel or number input.`;
  }
  for (const method of [field.formMethod, ...(field.submitMethods ?? [])]) {
    if (method !== undefined && method !== "post") {
      return `That field's form can submit with method="${method}", which would put the secret in a URL; it is not filled.`;
    }
  }
  for (const target of field.submitTargets) {
    let url: URL | undefined;
    try {
      url = new URL(target);
    } catch {
      url = undefined;
    }
    const host = url?.host ?? "";
    if (!hostAllowed(host, domains)) {
      return `That field's form submits to ${host || "an unreadable address"}, and the secret may only go to ${domains.join(", ")}.`;
    }
    // Cleartext is readable by everything between here and there. A page on this machine is exempt.
    if (url !== undefined && url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname))) {
      return `That field's form submits over ${url.protocol.replace(":", "")}, not https, so the secret would travel readable; it is not filled.`;
    }
  }
  return undefined;
}

/**
 * The page-side reader for `SecretField`, run on the field in an isolated world. The submitters
 * come from `form.elements`, not a query under the form: a button outside the form that joins it
 * with `form="id"` submits it too, and its `formaction` is a target like any other (INV-1380).
 * `hasForm` separates "no form" from "a form with no targets" so the caller can say so.
 */
export const SECRET_FIELD_DESCRIPTION =
  "function(){ const tag = (this.tagName || '').toLowerCase();" +
  " const type = tag === 'input' ? String(this.type || '').toLowerCase() : '';" +
  " const form = this.form || null; if (!form) return { tag, type, hasForm: false, submitTargets: [] };" +
  " const targets = [form.action];" +
  " const methods = [];" +
  " for (const el of Array.from(form.elements || [])) {" +
  "   const t = (el.tagName || '').toLowerCase(); const ty = String(el.type || '').toLowerCase();" +
  "   const submitter = (t === 'button' && ty !== 'button' && ty !== 'reset') || (t === 'input' && (ty === 'submit' || ty === 'image'));" +
  "   if (!submitter) continue;" +
  "   if (el.hasAttribute('formaction')) targets.push(el.formAction);" +
  "   if (el.hasAttribute('formmethod')) methods.push(String(el.formMethod || 'get').toLowerCase()); }" +
  " return { tag, type, hasForm: true, formMethod: String(form.method || 'get').toLowerCase(), submitMethods: methods, submitTargets: targets }; }";

/**
 * What the agent is told after a fill that went through, or undefined when there is nothing to
 * say. Lengths only: a field that kept fewer characters than the secret has (a `maxlength`, an
 * input mask) would submit a wrong credential, so the agent hears it before it presses submit.
 * A field with no form submits by script, where nobody here can see the destination.
 */
export function secretFillNote(field: SecretField, expected: number, kept: number): string | undefined {
  const notes: string[] = [];
  if (kept !== expected) {
    notes.push(`The field kept ${kept} of the secret's ${expected} characters (a length limit or an input mask); do not submit it as is — say what happened.`);
  }
  if (field.hasForm === false) {
    notes.push("This field is in no form, so where the page sends it on submit cannot be checked; the box's egress rules still apply.");
  }
  return notes.length === 0 ? undefined : notes.join(" ");
}

