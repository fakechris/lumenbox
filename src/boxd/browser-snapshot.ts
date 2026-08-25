/**
 * The script that reads a page, injected into it.
 *
 * The shape of the output is an indented outline rather than JSON, because the model
 * reads far more page per token from it — the same content as a JSON array of objects
 * costs roughly three times as much in braces, quotes and repeated key names, and the
 * indentation carries the nesting that the JSON would have had to state.
 *
 *     - heading "Sign in to Example"
 *     - textbox "Email address" [ref=e1]
 *     - textbox "Password" [ref=e2] value="<redacted>"
 *     - button "Sign in" [ref=e4]
 *     - link "Forgot your password?" [ref=e5] href="/account/recover"
 *
 * Only things worth acting on or reading get a line. A page is mostly wrappers, and a
 * faithful tree of every div is both enormous and harder to act on than the outline.
 *
 * Refs live in a map on the page and die when the page navigates. That is intentional
 * and safe here, because every action this box exposes ends by taking a fresh snapshot —
 * so the refs an agent holds are always the ones it was just given. The alternative,
 * refs that survive navigation by falling back to remembered CSS selectors, trades a
 * loud failure ("stale ref, look again") for a quiet one: a selector that still matches
 * something on a changed page, and a click that lands on the wrong element.
 */

/**
 * How many elements the whole outline may contain before it is cut.
 *
 * Across every frame together, not per frame. It was per frame, which meant a page with
 * ten iframes could return four thousand lines — the cap was the one thing keeping a
 * snapshot affordable, and frames quietly multiplied it.
 */
export const MAX_NODES = 400;

/**
 * Evaluated in the page. Returns the outline as a string.
 *
 * Written as a single expression so it can go straight into Runtime.evaluate, and it
 * deliberately touches nothing on the page except one property on globalThis: pages
 * break in surprising ways when something walks them and leaves attributes behind, and
 * this has to work on sites nobody tested it against.
 */
const SNAPSHOT_BODY = String.raw`
(() => {
  const MAX_NODES = __BUDGET__;
  const refs = new Map();
  globalThis.__lumenRefs = refs;
  const seen = new Map();
  const lines = [];
  let truncated = false;

  // A ref is derived from what the element *is*, not from where it came in the walk.
  //
  // Counting position was the obvious way and is quietly wrong: the counter restarts on
  // every snapshot, so a banner appearing at the top shifts everything, and e5 in the
  // snapshot an agent is holding becomes a different element in the next one. Acting on
  // it then lands somewhere else with nothing to report. Deriving the ref from role, name
  // and tag means the same element keeps its ref across snapshots, and an element that
  // changed gets a ref nobody is holding — so the failure is loud again.
  const refFor = (role, name, tag) => {
    const signature = role + "|" + name + "|" + tag;
    const nth = (seen.get(signature) || 0) + 1;
    seen.set(signature, nth);
    let hash = 2166136261;
    const source = signature + "#" + nth;
    for (let i = 0; i < source.length; i++) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    let ref = "e" + hash.toString(36).slice(0, 4);
    // Two different elements sharing a ref would make one of them unreachable, so a
    // collision is resolved rather than left to whichever was walked last.
    let bump = 1;
    while (refs.has(ref)) ref = "e" + hash.toString(36).slice(0, 4) + "x" + ++bump;
    return ref;
  };

  const INTERACTIVE = "a,button,input,textarea,select,summary,[role=button],[role=link]," +
    "[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[contenteditable=true]";
  // Anything that would get a line of its own. Used to decide whether a block of text is
  // its own content or merely the container of things already listed below it.
  const EMITTABLE = INTERACTIVE + ",p,li,td,th,h1,h2,h3,h4,h5,h6";

  const trim = (text, max) => {
    const flat = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    return flat.length > max ? flat.slice(0, max) + "…" : flat;
  };

  const visible = element => {
    if (element.getAttribute && element.getAttribute("aria-hidden") === "true") return false;
    const style = globalThis.getComputedStyle ? getComputedStyle(element) : null;
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
    // Zero-area elements are not reachable by a person and not clickable by us. Elements
    // scrolled out of view are kept: they are reachable, and dropping them would hide the
    // bottom of every long page.
    if (rect && rect.width === 0 && rect.height === 0) return false;
    return true;
  };

  const roleOf = element => {
    const explicit = element.getAttribute && element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return element.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "summary") return "disclosure";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "p") return "paragraph";
    if (tag === "li") return "listitem";
    if (tag === "td" || tag === "th") return "cell";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return type;
      if (type === "submit" || type === "button" || type === "reset") return "button";
      return "textbox";
    }
    if (element.isContentEditable) return "textbox";
    return "generic";
  };

  const nameOf = element => {
    const labelled = element.getAttribute && element.getAttribute("aria-labelledby");
    if (labelled) {
      const target = element.ownerDocument.getElementById(labelled.split(/\s+/)[0]);
      if (target) return trim(target.textContent, 80);
    }
    const direct = element.getAttribute && (
      element.getAttribute("aria-label") ||
      element.getAttribute("alt") ||
      element.getAttribute("placeholder") ||
      element.getAttribute("title")
    );
    if (direct) return trim(direct, 80);
    if (element.labels && element.labels.length > 0) return trim(element.labels[0].textContent, 80);
    if (element.tagName.toLowerCase() === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "submit" || type === "button") return trim(element.value, 80);
      return "";
    }
    return trim(element.textContent, 80);
  };

  // A password is never worth showing, and a snapshot of a login page is exactly where
  // one would otherwise end up — in a transcript, and in a model's context.
  const secret = element =>
    (element.getAttribute("type") || "").toLowerCase() === "password" ||
    /current-password|new-password/i.test(element.getAttribute("autocomplete") || "");

  const emit = (element, depth) => {
    const role = roleOf(element);
    const name = nameOf(element);
    const tag = element.tagName.toLowerCase();
    const interactive = element.matches && element.matches(INTERACTIVE);
    const textual = role === "heading" || tag === "p" || tag === "li" || tag === "td" || tag === "th";
    if (!interactive && !textual) return false;
    if (!interactive && name === "") return false;
    // A cell wrapping other cells reports all of their text as its own, so a nested table
    // prints its whole contents once per level — Hacker News' header came out three times.
    // The children are about to be listed individually, so the wrapper carries nothing.
    // Prose interrupted by a link is lost from the outline by this rule and kept by
    // browser_read, which is the tool for reading rather than acting.
    if (!interactive && element.querySelector && element.querySelector(EMITTABLE)) return false;

    let line = "  ".repeat(Math.min(depth, 6)) + "- " + role;
    if (name !== "") line += " " + JSON.stringify(name);
    if (interactive && !element.disabled) {
      const ref = refFor(role, name, tag);
      refs.set(ref, element);
      line += " [ref=" + ref + "]";
    }
    if (element.disabled) line += " disabled";
    if (element.checked === true) line += " checked";
    // A checkbox's value is "on" whether or not it is ticked. The "checked" flag above is
    // the part that carries meaning, and printing both invites reading the wrong one.
    const valued = (tag === "input" || tag === "textarea") && role !== "checkbox" && role !== "radio";
    if (valued) {
      const value = secret(element) ? "<redacted>" : trim(element.value, 40);
      if (value !== "") line += " value=" + JSON.stringify(value);
    }
    if (tag === "a" && element.getAttribute("href")) {
      line += " href=" + JSON.stringify(trim(element.getAttribute("href"), 80));
    }
    lines.push(line);
    return true;
  };

  const walk = (node, depth) => {
    if (lines.length >= MAX_NODES) { truncated = true; return; }
    if (depth > 20) return;
    for (const child of node.children) {
      if (lines.length >= MAX_NODES) { truncated = true; return; }
      const tag = child.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") continue;
      // Frames are walked separately, in their own execution context — their contents are
      // a different document and unreachable from here when they are cross-origin.
      if (tag === "iframe" || tag === "frame") continue;
      if (!visible(child)) continue;
      const shown = emit(child, depth);
      // Shadow roots are ordinary content to a person looking at the page, and invisible
      // to anything that only walks children. Design systems put entire applications in
      // here, so skipping them means an agent that cannot see half the web.
      if (child.shadowRoot) walk(child.shadowRoot, depth + (shown ? 1 : 0));
      walk(child, depth + (shown ? 1 : 0));
    }
  };

  const root = document.body || document.documentElement;
  if (root) walk(root, 0);
  if (truncated) lines.push("(snapshot cut at " + MAX_NODES + " elements)");
  return lines.join("\n");
})()
`;

/** Reads the visible prose of a page, for when the agent wants to read rather than act. */
export const READ_SCRIPT = String.raw`
(() => {
  const main = document.querySelector("main") || document.querySelector("article") || document.body;
  if (!main) return "";
  return main.innerText.replace(/\n{3,}/g, "\n\n").trim();
})()
`;


/**
 * The walker, with however much of the node budget is left.
 *
 * A page's frames share one budget rather than each having their own, so the main
 * document is walked first and an advertising iframe cannot spend the allowance the
 * content needed.
 */
export function snapshotScript(budget: number): string {
  return SNAPSHOT_BODY.replace("__BUDGET__", String(Math.max(0, Math.floor(budget))));
}

/** How much text `browser_read` may return, matching WebFetch's own limit. */
export const MAX_READ_CHARS = 40_000;
