/**
 * A verification report's page (INV-1925, docs/101): the recording on the left with the current
 * step over it, a timeline split by scenario with failures in red, and on the right the counts,
 * the conclusion and the two-level list. Clicking an assertion plays the recording from just
 * before it was checked. Drawn on the server from the report; the script only moves the video.
 */

import { reportCounts, type VerificationReport } from "../host/verification-report.ts";

/** Seconds of lead-in before an assertion's check, so the person sees what led to it. */
export const SEEK_LEAD_S = 2;

export interface ReportTimeline {
  durationMs: number;
  segments: { scenario: string; name: string; startPct: number; widthPct: number; failed: boolean }[];
  ticks: { id: string; pct: number; failed: boolean; seek: number }[];
  /** What the overlay says from each moment on: the assertion being worked toward. */
  steps: { t: number; label: string }[];
}

export function seekSeconds(offsetMs: number): number {
  return Math.max(0, Math.round((offsetMs / 1000 - SEEK_LEAD_S) * 10) / 10);
}

export function reportTimeline(report: VerificationReport): ReportTimeline {
  const checked = report.scenarios.flatMap(scenario => scenario.assertions).map(item => item.offsetMs ?? 0);
  const ran = report.startedAt && report.finishedAt ? Date.parse(report.finishedAt) - Date.parse(report.startedAt) : 0;
  const durationMs = Math.max(1, ran, ...checked);
  const pct = (ms: number) => Math.round((Math.min(ms, durationMs) / durationMs) * 1000) / 10;
  const segments: ReportTimeline["segments"] = [];
  const ticks: ReportTimeline["ticks"] = [];
  const steps: ReportTimeline["steps"] = [];
  // The overlay follows the order checks came in, whatever order the plan listed them: from one check to
  // the next, it names the assertion checked at the end of that stretch.
  const checks = report.scenarios
    .flatMap(scenario => scenario.assertions.flatMap(item => (item.offsetMs === undefined ? [] : [{ offsetMs: item.offsetMs, label: `${scenario.name} — ${item.fact}` }])))
    .sort((a, b) => a.offsetMs - b.offsetMs);
  checks.forEach((check, index) => {
    steps.push({ t: Math.round((index === 0 ? 0 : checks[index - 1]!.offsetMs) / 100) / 10, label: check.label });
  });
  let from = 0;
  for (const scenario of report.scenarios) {
    const offsets = scenario.assertions.flatMap(item => (item.offsetMs === undefined ? [] : [item.offsetMs]));
    const end = offsets.length > 0 ? Math.max(from, ...offsets) : from;
    const last = scenario === report.scenarios[report.scenarios.length - 1];
    const until = last ? durationMs : end;
    segments.push({ scenario: scenario.id, name: scenario.name, startPct: pct(from), widthPct: Math.max(0, pct(until) - pct(from)), failed: scenario.assertions.some(item => item.result === "fail") });
    for (const item of scenario.assertions) {
      if (item.offsetMs !== undefined) ticks.push({ id: item.id, pct: pct(item.offsetMs), failed: item.result === "fail", seek: seekSeconds(item.offsetMs) });
    }
    from = end;
  }
  return { durationMs, segments, ticks, steps };
}

const esc = (text: string): string => text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

/** The page's one behaviour: seek on a click, name the step as the video plays, say so when the video is gone. */
export const REPORT_PAGE_JS = `(function (doc, steps) {
  var video = doc.getElementById("video"), step = doc.getElementById("step"), gone = doc.getElementById("gone");
  function label(t) { var now = ""; for (var i = 0; i < steps.length; i++) if (steps[i].t <= t) now = steps[i].label; return now; }
  var seekers = doc.querySelectorAll("[data-seek]");
  for (var i = 0; i < seekers.length; i++) (function (el) {
    el.addEventListener("click", function () {
      if (!video) return;
      video.currentTime = Number(el.getAttribute("data-seek"));
      if (step) step.textContent = label(video.currentTime);
      var playing = video.play && video.play(); if (playing && playing.catch) playing.catch(function () {});
    });
  })(seekers[i]);
  if (video && step) { step.textContent = label(0); video.addEventListener("timeupdate", function () { step.textContent = label(video.currentTime); }); }
  if (video && gone) video.addEventListener("error", function () { gone.hidden = false; });
})`;

export function verificationPageHtml(report: VerificationReport): string {
  const counts = reportCounts(report);
  const timeline = reportTimeline(report);
  const seekOf = new Map(timeline.ticks.map(tick => [tick.id, tick.seek]));
  const segments = timeline.segments
    .map(segment => `<div class="seg${segment.failed ? " fail" : ""}" data-scenario="${esc(segment.scenario)}" ` +
      `style="left:${segment.startPct}%;width:${segment.widthPct}%" title="${esc(segment.name)}"></div>`)
    .join("");
  const ticks = timeline.ticks.map(tick => `<button class="tick${tick.failed ? " fail" : ""}" data-tick="${esc(tick.id)}" data-seek="${tick.seek}" style="left:${tick.pct}%" title="${esc(tick.id)}"></button>`).join("");
  const list = report.scenarios.map(scenario => `<section class="scenario"><h3>${esc(scenario.name)}</h3>${scenario.assertions.map(item => {
    const state = item.result ?? "unchecked";
    const seek = seekOf.get(item.id);
    const mark = state === "pass" ? "✓" : state === "fail" ? "✗" : "–";
    const observed = item.observed ? `<span class="observed">${esc(item.observed)}</span>` : "";
    return `<button class="item ${state}" data-assertion="${esc(item.id)}"${seek !== undefined ? ` data-seek="${seek}"` : " disabled"}>` +
      `<span class="mark">${mark}</span><span class="fact">${esc(item.fact)}</span>${observed}</button>`;
  }).join("")}</section>`).join("");
  const steps = JSON.stringify(timeline.steps).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(report.title)}</title><style>
body{margin:0;font:14px/1.45 system-ui,sans-serif;background:#111418;color:#e6e8eb}main{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:16px;padding:16px;min-height:100vh;box-sizing:border-box}
.stage{position:relative;background:#000;border-radius:8px;overflow:hidden}video{display:block;width:100%;max-height:72vh}
.step{position:absolute;left:12px;top:12px;right:12px;padding:6px 10px;background:rgba(0,0,0,.65);border-radius:6px;font-weight:600;pointer-events:none}
.timeline{position:relative;height:22px;margin-top:10px;background:#22272e;border-radius:4px}.seg{position:absolute;top:0;bottom:0;border-right:2px solid #111418;background:#2f6f4f}.seg.fail{background:#8b2f2f}
.tick{position:absolute;top:-3px;width:6px;height:28px;margin-left:-3px;padding:0;border:0;border-radius:2px;background:#c9d1d9;cursor:pointer}.tick.fail{background:#ff5c5c}
aside h1{font-size:18px;margin:0 0 4px}.version{color:#9aa4ae;font-size:12px;margin-bottom:12px}.counts{display:flex;gap:8px;margin-bottom:12px}
.count{flex:1;padding:8px;border-radius:6px;background:#22272e;text-align:center}.count b{display:block;font-size:20px}
.count.pass b{color:#56d364}.count.fail b{color:#ff5c5c}.conclusion{padding:10px;border-radius:6px;background:#22272e;margin-bottom:12px;white-space:pre-wrap}h3{font-size:13px;margin:12px 0 6px;color:#9aa4ae}

.item{display:grid;grid-template-columns:18px 1fr;gap:2px 6px;width:100%;text-align:left;padding:6px 8px;margin-bottom:4px;border:1px solid #2d333b;border-radius:6px;background:#161b22;color:inherit;font:inherit;cursor:pointer}
.item[disabled]{cursor:default;opacity:.7}
.item.pass .mark{color:#56d364}.item.fail{border-color:#8b2f2f}.item.fail .mark{color:#ff5c5c}.observed{grid-column:2;color:#9aa4ae;font-size:12px}.gone{margin-top:8px;color:#e3b341}@media(max-width:900px){main{grid-template-columns:1fr}}
</style></head><body><main>
<section class="player"><div class="stage">${report.recording ? `<video id="video" controls preload="metadata" src="/verification/${esc(report.id)}/video"></video>` : ""}<div id="step" class="step"></div></div>
<div class="timeline" id="timeline">${segments}${ticks}</div>
<p id="gone" class="gone"${report.recording ? " hidden" : ""}>The recording is no longer in the box (recordings are kept 14 days and 2 GB per box); the assertions and conclusion still stand.</p></section>
<aside><h1>${esc(report.title)}</h1><div class="version">${esc(report.agentName)} · ${esc(report.version)} · ${esc(report.finishedAt ?? report.createdAt)}${report.state !== "finished" ? ` · ${esc(report.state)}` : ""}</div>
<div class="counts"><div class="count pass"><b>${counts.passed}</b>Passed</div><div class="count fail"><b>${counts.failed}</b>Failed</div><div class="count"><b>${counts.unchecked}</b>Not checked</div></div>
${report.conclusion ? `<div class="conclusion">${esc(report.conclusion)}</div>` : ""}${list}</aside>
</main><script>${REPORT_PAGE_JS}(document, ${steps});</script></body></html>`;
}
