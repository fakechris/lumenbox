import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { VerificationReports, type VerificationReport } from "../host/verification-report.ts";
import { REPORT_PAGE_JS, reportTimeline, verificationPageHtml } from "./verification-page.ts";
import { verificationRoute } from "./verification-routes.ts";

const REPORT: VerificationReport = {
  id: "vr-1a2b3c4d", agentId: "a-ada", agentName: "Ada", conversation: "main", title: "Export to CSV", version: "abc1234", state: "finished",
  createdAt: "2026-11-20T09:00:00.000Z", startedAt: "2026-11-20T09:00:00.000Z", finishedAt: "2026-11-20T09:00:20.000Z",
  recording: { file: "verify-vr-1a2b3c4d.mp4", display: 1 }, conclusion: "Downloads work; the header row is missing.",
  scenarios: [
    { id: "s1", name: "Export", assertions: [
      { id: "s1.a1", fact: "the button downloads a file", result: "pass", observed: "export.csv", offsetMs: 4_000 },
      { id: "s1.a2", fact: "the file has a header row", result: "fail", observed: "no header", offsetMs: 10_000 },
    ] },
    { id: "s2", name: "Empty table", assertions: [{ id: "s2.a1", fact: "only the header", result: "pass", observed: "ok", offsetMs: 16_000 }] },
  ],
};

test("the timeline splits by scenario, colours the failed one and puts each assertion where it was checked", () => {
  const timeline = reportTimeline(REPORT);
  assert.equal(timeline.durationMs, 20_000);
  assert.deepEqual(timeline.segments.map(segment => [segment.scenario, segment.startPct, segment.widthPct, segment.failed]), [["s1", 0, 50, true], ["s2", 50, 50, false]]);
  assert.deepEqual(timeline.ticks.map(tick => [tick.id, tick.pct, tick.failed, tick.seek]), [["s1.a1", 20, false, 2], ["s1.a2", 50, true, 8], ["s2.a1", 80, false, 14]]);
  assert.equal(timeline.steps.find(step => step.t === 4)?.label, "Export — the file has a header row", "after the first check the overlay names the next");

  const page = verificationPageHtml(REPORT);
  assert.match(page, /<div class="seg fail" data-scenario="s1"/);
  assert.match(page, /<div class="seg" data-scenario="s2"/);
  assert.match(page, /<button class="item fail" data-assertion="s1\.a2" data-seek="8">/);
  assert.match(page, /src="\/verification\/vr-1a2b3c4d\/video"/);
});

test("clicking an assertion plays the recording from just before it was checked, and the overlay names the step", () => {
  const listeners = new Map<string, () => void>();
  const button = (id: string, seek: string) => ({ getAttribute: () => seek, addEventListener: (_: string, fn: () => void) => listeners.set(id, fn) });
  const video = { currentTime: 0, played: 0, play() { this.played++; return Promise.resolve(); }, addEventListener: () => {} };
  const step = { textContent: "" };
  const doc = {
    getElementById: (id: string) => (id === "video" ? video : id === "step" ? step : null),
    querySelectorAll: () => [button("s1.a2", "8"), button("s2.a1", "14")],
  };
  runInNewContext(`(${REPORT_PAGE_JS})(doc, steps)`, { doc, steps: reportTimeline(REPORT).steps, Number });
  listeners.get("s1.a2")!();
  assert.equal(video.currentTime, 8);
  assert.equal(video.played, 1);
  assert.equal(step.textContent, "Export — the file has a header row");
  listeners.get("s2.a1")!();
  assert.equal(video.currentTime, 14);
  assert.equal(step.textContent, "Empty table — only the header");
});

test("the report's routes refuse a caller who may not see the member, and serve the video from its box", async () => {
  const reports = new VerificationReports(join(mkdtempSync(join(tmpdir(), "agentbox-vr-")), "verification-reports"));
  reports.save(REPORT);
  const proxied: string[] = [];
  let allowed = true;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await verificationRoute(`${req.method} ${url.pathname}`, res, {
      reports, mayReadAgent: () => allowed,
      send: (r, status, body, type) => { r.writeHead(status, { "content-type": type ?? "application/json" }); r.end(typeof body === "string" ? body : JSON.stringify(body)); },
      proxyVideo: async (agentId, file) => { proxied.push(`${agentId}/${file}`); res.writeHead(200, { "content-type": "video/mp4" }); res.end("mp4"); },
    });
    if (!handled) { res.writeHead(418); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const at = (path: string) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
  try {
    assert.equal((await at("/verification/vr-1a2b3c4d")).status, 200);
    assert.equal(((await (await at("/api/verification/vr-1a2b3c4d")).json()) as { counts: { failed: number } }).counts.failed, 1);
    assert.equal(await (await at("/verification/vr-1a2b3c4d/video")).text(), "mp4");
    assert.deepEqual(proxied, ["a-ada/verify-vr-1a2b3c4d.mp4"]);
    assert.equal((await at("/verification/vr-00000000")).status, 404);
    assert.equal((await at("/verification/elsewhere")).status, 418, "not this route");
    allowed = false;
    assert.equal((await at("/verification/vr-1a2b3c4d")).status, 403);
    assert.equal((await at("/verification/vr-1a2b3c4d/video")).status, 403);
    assert.equal(proxied.length, 1);
  } finally { server.close(); }
});
