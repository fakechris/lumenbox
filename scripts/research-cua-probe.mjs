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
  async readElements() {
    if (this.unavailable) return { error: "fixture accessibility read unavailable" };
    return {
      window: { title: "Fixture", app: "fixture", truncated: false, identity: "fixture-window" },
      elements: [{ ref: "a1", identity: "fixture-control", role: "button", name: "Save", x: this.targetX,
        y: 10, width: 20, height: 20, states: [] }],
    };
  }
  async executeAction(action) {
    if (action.action === "click_element") this.clicks.push(this.elementCentre(action.ref));
    this.frame++;
  }
  async takeScreenshot() { return `fixture-frame-${this.frame}`; }
}

const afterReadFailure = new Probe();
const firstRead = await afterReadFailure.execute([{ action: "list_elements" }]);
afterReadFailure.unavailable = true;
await afterReadFailure.execute([{ action: "list_elements" }]);
let staleError;
try { await afterReadFailure.execute([{ action: "click_element", ref: firstRead.elements[0].ref }]); }
catch (error) { staleError = error.message; }

const reuse = new Probe();
const oldRead = await reuse.execute([{ action: "list_elements" }]);
reuse.targetX = 700;
await reuse.execute([{ action: "list_elements" }]);
let reuseError;
try { await reuse.execute([{ action: "click_element", ref: oldRead.elements[0].ref }]); }
catch (error) { reuseError = error.message; }

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
    oldRef: oldRead.elements[0].ref, resolvesAfterNewObservation: reuse.clicks, refusal: reuseError ?? null,
  },
  screenshotBeforeWriteReturnedAsFinal: {
    reproduced: batchResult.screenshot !== `fixture-frame-${batch.frame}`,
    returned: batchResult.screenshot, actualFixtureState: `fixture-frame-${batch.frame}`,
  },
  pixelsAloneConfirm: { reproduced: evidenceEffect === "confirmed", fraction, effect: evidenceEffect },
  noopIsOutcomeOk: { reproduced: noopOutcome === "ok", outcome: noopOutcome },
}, null, 2));
