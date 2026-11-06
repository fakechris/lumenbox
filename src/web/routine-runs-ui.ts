/**
 * A routine's run history, expanded under its row; the attention list's Resume; and Settings →
 * Team → Routines for K (INV-1665). Its own script, like the other settings sections: the page is
 * at its size ceiling. The row in app-html.ts carries a "Runs" button and an empty
 * `[data-runs-for]` box; everything that fills it is here.
 */

export const ROUTINE_RUNS_JS = `(function () {
  function esc(text) { return String(text == null ? "" : text).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function el(tag, attrs, text) { var n = document.createElement(tag); for (var k in attrs) n.setAttribute(k, attrs[k]); if (text !== undefined) n.textContent = text; return n; }
  function call(method, path, body) {
    return fetch(path, method === "GET" ? {} : { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); });
  }
  var WORD = { done: "done", partial: "partial", failed: "failed", skipped: "skipped", observed: "observed", running: "running", interrupted: "interrupted" };
  var TONE = { failed: "danger", partial: "warn", skipped: "warn", interrupted: "warn" };
  var open = {};
  function when(iso) { return new Date(iso).toLocaleString(); }
  function render(box, data) {
    var runs = data.runs || [];
    var html = '<div style="margin-top:6px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:11.5px">';
    // A hold is said on the row itself; here only the count towards one.
    if (!data.hold && data.failures) html += '<div class="dim" style="margin-bottom:4px">' + data.failures + " failed in a row; it pauses at " + data.pauseAfter + ".</div>";
    html += '<div class="dim" style="text-transform:uppercase;letter-spacing:.04em;font-size:10px">Last ' + runs.length + " run" + (runs.length === 1 ? "" : "s") + "</div>";
    html += runs.length ? runs.map(function (run) {
      var link = run.agentId ? ' <a href="#" data-run-open="' + esc(run.agentId) + '" data-run-conversation="' + esc(run.conversation || "main") + '">' + esc(run.agentName || "open") + "</a>" : "";
      return '<div data-run-row style="display:flex;gap:8px;align-items:baseline;padding:2px 0"><span class="mono dim" style="min-width:150px">' + esc(when(run.at)) + "</span>" +
        '<span class="' + (TONE[run.outcome] || "") + '" style="min-width:70px">' + esc(WORD[run.outcome] || run.outcome) + (run.manual ? ' <span class="dim">by hand</span>' : "") + "</span>" +
        '<span style="flex:1" class="dim">' + esc(run.reason || "") + (run.ms != null ? " · " + Math.round(run.ms / 1000) + "s" : "") + "</span>" + link + "</div>";
    }).join("") : '<div class="dim">No runs recorded yet.</div>';
    var next = data.upcoming || [];
    if (next.length) html += '<div class="dim" style="text-transform:uppercase;letter-spacing:.04em;font-size:10px;margin-top:6px">Next</div><div class="mono">' + next.map(function (iso) { return esc(when(iso)); }).join(" · ") + "</div>";
    html += '<div class="dim" style="margin-top:6px;font-style:italic">' + esc(data.doneMeans || "") + "</div></div>";
    box.innerHTML = html;
  }
  function load(slug) {
    var box = document.querySelector('[data-runs-for="' + slug.replace(/"/g, '\\\\"') + '"]');
    if (!box) return;
    box.style.display = "";
    box.textContent = "Reading the runs…";
    call("GET", "/api/schedules/runs?slug=" + encodeURIComponent(slug)).then(function (d) { render(box, d); }).catch(function (e) { box.textContent = e.message; });
  }
  // The automations list is re-rendered on every refresh; an expanded row stays expanded.
  var watch = setInterval(function () {
    var list = document.getElementById("autolist");
    if (!list) return;
    clearInterval(watch);
    new MutationObserver(function () { Object.keys(open).forEach(function (slug) { var box = document.querySelector('[data-runs-for="' + slug + '"]'); if (box && box.style.display === "none") load(slug); }); }).observe(list, { childList: true });
  }, 250);
  document.addEventListener("click", function (event) {
    var t = event.target && event.target.closest ? event.target : null;
    if (!t) return;
    var toggle = t.closest("[data-runs]"), go = t.closest("[data-run-open]"), resume = t.closest("[data-routine-resume]");
    if (toggle) {
      event.preventDefault();
      var slug = toggle.getAttribute("data-runs");
      var box = document.querySelector('[data-runs-for="' + slug.replace(/"/g, '\\\\"') + '"]');
      if (open[slug]) { delete open[slug]; if (box) box.style.display = "none"; toggle.textContent = "Runs"; return; }
      open[slug] = true; toggle.textContent = "Hide runs"; load(slug);
    } else if (go && typeof select === "function") {
      event.preventDefault();
      select(go.getAttribute("data-run-open"), go.getAttribute("data-run-conversation"));
    } else if (resume) {
      event.preventDefault();
      resume.disabled = true;
      call("POST", "/api/schedules/resume", { slug: resume.getAttribute("data-routine-resume") })
        .catch(function (e) { alert(e.message); })
        .then(function () { if (typeof renderAttention === "function") renderAttention(); if (typeof refreshAutomations === "function") refreshAutomations(); });
    }
  });
  // Settings → Team → Routines: K.
  function mount() {
    var modal = document.querySelector("#settingswrap .modal");
    if (!modal || document.getElementById("routinepause")) return false;
    var field = el("div", { class: "field settab-off", "data-settab": "team", id: "routinepause" });
    field.appendChild(el("label", {}, "Routines"));
    field.appendChild(el("div", { class: "fieldnote" }, "A routine that fails this many times in a row is paused, with the last failure as the reason, until someone resumes it. 0 never pauses."));
    var row = el("div", { class: "ui-list-row" });
    row.appendChild(el("span", { class: "ui-grow" }, "Pause after failures in a row"));
    var input = el("input", { type: "number", min: "0", max: "100", value: "3", "aria-label": "Failures in a row before a routine pauses", class: "ui-w-xs" });
    var note = el("div", { class: "fieldnote" }, "");
    input.onchange = function () { call("POST", "/api/schedules/pause-after", { pauseAfter: Number(input.value) }).then(function (d) { input.value = String(d.pauseAfter); note.textContent = "Saved: " + d.pauseAfter + "."; }).catch(function (e) { note.textContent = e.message; }); };
    row.appendChild(input); field.appendChild(row); field.appendChild(note);
    modal.insertBefore(field, modal.querySelector(".actions"));
    call("GET", "/api/schedules/pause-after").then(function (d) { input.value = String(d.pauseAfter); }).catch(function () {});
    return true;
  }
  var tries = 0, wait = setInterval(function () { if (mount() || ++tries > 40) clearInterval(wait); }, 250);
})();
`;
