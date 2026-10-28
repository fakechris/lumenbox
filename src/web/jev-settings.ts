/**
 * Settings → Model → Decision model (INV-1412): one switch per judgement point and the key.
 *
 * Its own script, served at /app/jev-settings.js and loaded by the page, rather than markup in
 * app-html.ts: the page is one inlined document at its size ceiling, and this section is wholly
 * self-contained — it adds its own field to the Model tab and talks only to /api/jev. ES5 and
 * string concatenation, like the page it joins.
 */

import { jevSwitch, typesafeToken } from "../config.ts";
import type { JevMode, JevPoint } from "../host/jev.ts";

/** Every point, what it does in a sentence, and which modes it allows. */
export const JEV_POINTS: { point: JevPoint; label: string; modes: JevMode[] }[] = [
  { point: "memory_judge", label: "Memory: judge each new memory before it is kept", modes: ["off", "shadow", "on"] },
  { point: "answer_review", label: "Replies: check that a reply answers the request", modes: ["off", "shadow", "on"] },
  { point: "memory_select", label: "Memory: choose which memories each turn sees", modes: ["off", "shadow", "on"] },
  { point: "auto_review", label: "Tool calls: compare with the authorisation review (never decides)", modes: ["off", "shadow"] },
  { point: "routine_resolve", label: "Routines: decide whether a result interrupts anyone", modes: ["off", "shadow", "on"] },
  { point: "computer_verify", label: "Desktop: check the screen matches what an action expected", modes: ["off", "shadow", "on"] },
  { point: "computer_wait", label: "Desktop: wait until the screen shows something", modes: ["off", "on"] },
  { point: "computer_click", label: "Desktop: click a control by its description", modes: ["off", "on"] },
  { point: "computer_guard", label: "Desktop: ask a person before clicking send, pay or delete", modes: ["off", "shadow", "on"] },
];

/** What GET /api/jev answers: whether a key exists (never the key), and each point's mode. */
export function jevSettings(): { keyPresent: boolean; points: { point: JevPoint; label: string; modes: JevMode[]; mode: JevMode }[] } {
  return {
    keyPresent: typesafeToken() !== undefined,
    points: JEV_POINTS.map(entry => {
      const mode = jevSwitch(entry.point);
      return { ...entry, mode: entry.modes.includes(mode) ? mode : "off" };
    }),
  };
}

/** The config env change a POST /api/jev body asks for, or why it cannot be saved. */
export function jevSettingsChange(body: Record<string, unknown>): { env: Record<string, string | null> } | { error: string } {
  const env: Record<string, string | null> = {};
  const points = (body.points ?? {}) as Record<string, unknown>;
  for (const [point, mode] of Object.entries(points)) {
    const entry = JEV_POINTS.find(candidate => candidate.point === point);
    if (entry === undefined) return { error: `Unknown judgement point "${point}".` };
    if (typeof mode !== "string" || !entry.modes.includes(mode as JevMode)) return { error: `${point} takes ${entry.modes.join(", ")}.` };
    env[`AGENTBOX_JEV_${point.toUpperCase()}`] = mode === "off" ? null : mode;
  }
  if (typeof body.key === "string" && body.key.trim() !== "") env.TYPESAFE_TOKEN = body.key.trim();
  return { env };
}

export const JEV_SETTINGS_JS = `(function () {
  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function post(body, status) {
    status.textContent = "Saving…";
    fetch("/api/jev", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || "save failed"); return d; }); })
      .then(function (d) { render(d); status.textContent = "Saved; in force from the next judgement."; })
      .catch(function (e) { status.textContent = e.message; });
  }
  var field, status, keyNote, rows;
  function render(data) {
    keyNote.textContent = data.keyPresent ? "A key is set (TYPESAFE_TOKEN)." : "No key: every switch acts as off until TYPESAFE_TOKEN is set or pasted here.";
    rows.textContent = "";
    data.points.forEach(function (p) {
      var row = el("div", { style: "display:flex;gap:8px;align-items:center" });
      var select = el("select", { "data-point": p.point, style: "width:90px;flex:none" });
      p.modes.forEach(function (m) { var o = el("option", { value: m }, m); if (m === p.mode) o.selected = true; select.appendChild(o); });
      select.addEventListener("change", function () { var points = {}; points[p.point] = select.value; post({ points: points }, status); });
      row.appendChild(select);
      row.appendChild(el("span", { class: "dim", style: "font-size:12px" }, p.label));
      rows.appendChild(row);
    });
  }
  function mount() {
    // After the model section's closing note (the one under the API key), so the provider's key
    // and this model's key are not read as one field.
    var keyInput = document.getElementById("setkey");
    var keyField = keyInput && keyInput.closest(".field");
    var anchor = keyField && keyField.nextElementSibling;
    if (!anchor || document.getElementById("setjev")) return;
    field = el("div", { class: "field", id: "setjev", "data-tier": "installation", "data-settab": "model" });
    field.appendChild(el("label", {}, "Decision model"));
    field.appendChild(el("div", { class: "fieldnote", style: "margin:0" }, "A fast yes/no and multiple-choice model for the host's own judgements. off makes no call; shadow keeps today's behaviour and logs both answers to ~/.agentbox/jev-shadow.jsonl; on uses it and falls back when it fails. It never alone allows an action."));
    keyNote = el("div", { class: "fieldnote" });
    field.appendChild(keyNote);
    var key = el("input", { type: "password", placeholder: "paste a TypeSafe key (optional)", autocomplete: "off", spellcheck: "false" });
    key.addEventListener("change", function () { if (key.value.trim() !== "") { post({ key: key.value.trim() }, status); key.value = ""; } });
    field.appendChild(key);
    rows = el("div", { style: "display:flex;flex-direction:column;gap:4px;margin-top:6px" });
    field.appendChild(rows);
    status = el("div", { class: "fieldnote" });
    field.appendChild(status);
    anchor.parentNode.insertBefore(field, anchor.nextSibling);
    fetch("/api/jev").then(function (r) { return r.ok ? r.json() : null; }).then(function (d) { if (d) render(d); else field.style.display = "none"; });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
`;
