/**
 * INV-635 research probe. Exercises the real batch/cache logic with native I/O
 * replaced by an in-memory fixture. Does not control a desktop or read home.
 * A "reproduced" result describes a gap, not a passing product acceptance test.
 * Run: node --experimental-transform-types scripts/research-cua-probe.mjs
 */
import { X11Executor } from "../src/cua/x11-executor.ts";
import { computerOutcome } from "../src/protocol/index.ts";
import { effectOf, regionDiff } from "../src/cua/effect.ts";

class Probe extends X11Executor {
  frame = 0;
  unavailable = false;
  targetX = 10;
  clicks = [];
  constructor() {
    super({ display: ":99", resolution: {
      display: { width: 1280, height: 800 }, api: { width: 1280, height: 800 },
    }, screenshotDelayMs: 0, effectSettleMs: 0, measureEffect: false });
  }
  async listElements() {
    if (this.unavailable) return { error: "fixture accessibility read unavailable" };
    return this.adoptElements({
      window: { title: "Fixture", app: "fixture", truncated: false },
      elements: [{ ref: "a1", role: "button", name: "Save", x: this.targetX,
        y: 10, width: 20, height: 20, states: [] }],
    });
  }
  async executeAction(action) {
    if (action.action === "click_element") this.clicks.push(this.elementCentre(action.ref));
    this.frame++;
  }
  async takeScreenshot() { return `fixture-frame-${this.frame}`; }
}

const afterReadFailure = new Probe();
await afterReadFailure.execute([{ action: "list_elements" }]);
afterReadFailure.unavailable = true;
await afterReadFailure.execute([{ action: "list_elements" }]);
let staleError;
try { await afterReadFailure.execute([{ action: "click_element", ref: "a1" }]); }
catch (error) { staleError = error.message; }

const reuse = new Probe();
await reuse.execute([{ action: "list_elements" }]);
reuse.targetX = 700;
await reuse.execute([{ action: "list_elements" }]);
await reuse.execute([{ action: "click_element", ref: "a1" }]);

const batch = new Probe();
const batchResult = await batch.execute([
  { action: "screenshot" }, { action: "click", coordinate: [10, 10] },
]);

const fraction = regionDiff(Buffer.alloc(300, 0), Buffer.alloc(300, 255));
const evidenceEffect = effectOf(fraction);
const noopOutcome = computerOutcome({ success: true, screenshot: "fixture", effect: "suspected_noop" });

console.log(JSON.stringify({
  scope: "real executor control flow; fake native I/O; no GUI delivery or upstream performance tested",
  failedTreeKeepsOldRef: {
    reproduced: afterReadFailure.clicks.length === 1,
    deliveredToFixture: afterReadFailure.clicks, refusal: staleError ?? null,
  },
  refReusedAcrossSnapshots: {
    reproduced: reuse.clicks[0]?.x === 710,
    oldRef: "a1", resolvesAfterNewObservation: reuse.clicks,
  },
  screenshotBeforeWriteReturnedAsFinal: {
    reproduced: batchResult.screenshot !== `fixture-frame-${batch.frame}`,
    returned: batchResult.screenshot, actualFixtureState: `fixture-frame-${batch.frame}`,
  },
  pixelsAloneConfirm: { reproduced: evidenceEffect === "confirmed", fraction, effect: evidenceEffect },
  noopIsOutcomeOk: { reproduced: noopOutcome === "ok", outcome: noopOutcome },
}, null, 2));
