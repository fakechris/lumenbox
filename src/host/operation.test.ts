/** Operations (INV-1378): a declarative browser recipe the host replays without a model, typed and gated. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserRequest } from "../protocol/index.ts";
import { casesPass, commitsOf, type Operation, operationProblem, runCases, runOperation } from "./operation.ts";

const REPORT: Operation = {
  name: "Weekly signups",
  input: { week: { type: "string" } },
  output: { signups: { type: "number" } },
  steps: [
    { open: "https://analytics.example.com/reports/{week}" },
    { act: { action: "click", find: { role: "button", name: "Show table" } } },
    { read: { as: "signups", pattern: "Signups\\s+([\\d,]+)" } },
  ],
};

/** A site with one report page per week; the table appears after Show table. */
function site(numbers: Record<string, string>) {
  const calls: BrowserRequest[] = [];
  let url = "";
  let shown = false;
  const browser = async (request: BrowserRequest) => {
    calls.push(request);
    if (request.op === "open") {
      url = request.url ?? "";
      shown = false;
      return { url, outcome: "ok" };
    }
    if (request.op === "act") {
      if (request.find?.name === "Show table") shown = true;
      else return { url, outcome: "failed" };
      return { url, outcome: "ok" };
    }
    if (request.op === "read") {
      const week = decodeURIComponent(url.split("/").at(-1) ?? "");
      return { url, text: shown && numbers[week] !== undefined ? `Weekly report\nSignups ${numbers[week]}\nChurn 3` : "Weekly report" };
    }
    return { url, outcome: "ok" };
  };
  return { browser, calls };
}

test("an operation runs its steps through the browser and returns typed output — no model anywhere", async () => {
  const { browser, calls } = site({ "2026-W43": "1,204" });
  const result = await runOperation(REPORT, { week: "2026-W43" }, browser);
  assert.deepEqual(result, { ok: true, output: { signups: 1204 } });
  assert.deepEqual(calls.map(c => c.op), ["open", "act", "read"]);
  assert.equal(calls[0]!.url, "https://analytics.example.com/reports/2026-W43");
  assert.deepEqual(calls[1]!.find, { role: "button", name: "Show table" }, "found by role and name, never a ref or coordinates");
});

test("failures are typed: bad input, a missing element, nothing to read, a wrong type", async () => {
  const { browser } = site({ "2026-W43": "lots" });
  assert.deepEqual(await runOperation(REPORT, {}, browser), { ok: false, code: "invalid_input", detail: "input week is missing" });
  assert.equal((await runOperation(REPORT, { week: 43 }, browser) as { code: string }).code, "invalid_input");
  assert.equal((await runOperation(REPORT, { week: "2026-W01" }, browser) as { code: string }).code, "not_found");
  assert.match(JSON.stringify(await runOperation({ ...REPORT, steps: [REPORT.steps[0]!, { act: { action: "click", find: { name: "Gone" } } }, REPORT.steps[2]!] }, { week: "x" }, browser)), /"code":"step_failed","step":1/);
  const typed = await runOperation({ ...REPORT, steps: [REPORT.steps[0]!, REPORT.steps[1]!, { read: { as: "signups", pattern: "Signups\\s+(\\S+)" } }] }, { week: "2026-W43" }, browser);
  assert.deepEqual(typed, { ok: false, code: "output_type", detail: 'signups is "lots", not a number' });
});

test("the validator refuses coordinates, unread outputs, undeclared placeholders and odd step kinds", () => {
  assert.equal(operationProblem(REPORT), undefined);
  assert.match(operationProblem({ ...REPORT, steps: [{ act: { action: "click", find: {} } }] }) ?? "", /role and\/or name/);
  assert.match(operationProblem({ ...REPORT, steps: [REPORT.steps[0]!] }) ?? "", /no step reads output signups/);
  assert.match(operationProblem({ ...REPORT, steps: [{ open: "https://x.example.com/{year}" }, REPORT.steps[2]!] }) ?? "", /\{year\} is used/);
  assert.match(operationProblem({ ...REPORT, steps: [{ eval: "fetch('/steal')" } as never] }) ?? "", /one of open, act, read, wait/);
  assert.match(operationProblem({ ...REPORT, steps: [{ open: "javascript:alert(1)" }, REPORT.steps[2]!] }) ?? "", /http/);
});

test("a write operation asks first, and its dry run stops before the first commit", async () => {
  const pay: Operation = {
    name: "Pay invoice",
    input: { invoice: { type: "string" } },
    output: { reference: { type: "string" } },
    steps: [
      { open: "https://billing.example.com/invoices/{invoice}" },
      { act: { action: "click", find: { role: "button", name: "Show table" } } },
      { act: { action: "click", find: { role: "button", name: "Pay" }, commit: "pay" } },
      { read: { as: "reference", pattern: "Ref (\\w+)" } },
    ],
  };
  assert.deepEqual(commitsOf(pay), ["pay"]);
  const { browser, calls } = site({});
  assert.equal((await runOperation(pay, { invoice: "A1" }, browser) as { code: string }).code, "needs_approval");
  assert.equal(calls.length, 0, "nothing reached the page before approval");
  const dry = await runCases(pay, [{ purpose: "pays A1", input: { invoice: "A1" } }], browser);
  assert.deepEqual(dry, { passed: 1, total: 1, failures: [] });
  assert.ok(!calls.some(c => c.find?.name === "Pay"), "the dry run never pressed Pay");
});

test("cases decide the publish gate at 70%", async () => {
  const { browser } = site({ "2026-W43": "1204", "2026-W44": "998" });
  const result = await runCases(REPORT, [
    { purpose: "a normal week", input: { week: "2026-W43" }, expect: { signups: "^\\d+$" } },
    { purpose: "the next week", input: { week: "2026-W44" }, expect: { signups: "^998$" } },
    { purpose: "a week with no data", input: { week: "2026-W01" } },
  ], browser);
  assert.equal(result.passed, 2);
  assert.match(result.failures[0]!, /a week with no data: not_found at step 2/);
  assert.equal(casesPass(result), false, "2/3 is under 70%");
  assert.equal(casesPass({ passed: 3, total: 4 }), true);
  assert.equal(casesPass({ passed: 0, total: 0 }), false, "no cases, no publish");
});
