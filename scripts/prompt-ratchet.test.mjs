/**
 * The prompt ratchet (INV-1857): a byte more fails and says what to do, a byte less passes,
 * `--write-baseline` only lowers, and the reminder goes to the pull requests it is about.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASELINE_FILE, evalHints, lowered, raised, slack, verify } from "./prompt-ratchet.mjs";

/** What the ratchet measures of a prompt: UTF-8 bytes of each half and of the tool list as JSON. */
const sizes = ({ stable, volatile, tools }) => ({ stable: Buffer.byteLength(stable), volatile: Buffer.byteLength(volatile), tools: Buffer.byteLength(JSON.stringify(tools)) });
const fixture = { stable: "You are Nova. Check before you claim.", volatile: "# Before you answer\n\n- 回答问到的全部。", tools: [{ name: "bash", description: "Run a command.", input_schema: { type: "object" } }] };
const baseline = { single: sizes(fixture) };

test("a prompt one byte longer fails, naming the number, its new value and the two ways out; one byte shorter passes", () => {
  assert.deepEqual(verify(baseline, { single: sizes(fixture) }), [], "held at its ceiling");

  for (const [measure, grown] of [
    ["stable", { ...fixture, stable: `${fixture.stable}!` }],
    ["volatile", { ...fixture, volatile: `${fixture.volatile}!` }],
    ["tools", { ...fixture, tools: [{ ...fixture.tools[0], description: "Run a command.!" }] }],
  ]) {
    const now = sizes(grown)[measure];
    assert.equal(now, baseline.single[measure] + 1);
    const problems = verify(baseline, { single: sizes(grown) });
    assert.equal(problems.length, 1, `only ${measure} grew`);
    assert.match(problems[0], new RegExp(`^single: .* is ${now} bytes, 1 over its ceiling of ${baseline.single[measure]}\\. Shrink it`));
    assert.ok(problems[0].includes(`raise "single" → "${measure}" to ${now} in ${BASELINE_FILE} and say why in the pull request`), problems[0]);
  }
  // Bytes, not characters: one more Chinese character is three more.
  assert.match(verify(baseline, { single: sizes({ ...fixture, volatile: `${fixture.volatile}好` }) })[0], /3 over its ceiling/);

  const shorter = { single: sizes({ ...fixture, stable: fixture.stable.slice(1) }) };
  assert.deepEqual(verify(baseline, shorter), []);
  assert.deepEqual(slack(baseline, shorter), ["single.stable −1"], "and what could be kept is said");
});

test("a configuration measured and not listed, or listed and not measured, is a problem with its own instruction", () => {
  const measured = { single: sizes(fixture), unattended: sizes(fixture) };
  assert.match(verify(baseline, measured).join("\n"), /has no entry for the configuration "unattended": add \{"unattended":\{"stable":\d+,"volatile":\d+,"tools":\d+\}\}/);
  assert.match(verify({ ...baseline, gone: baseline.single }, { single: sizes(fixture) }).join("\n"), /lists "gone", which is not a configuration.*remove the entry/);
});

test("--write-baseline lowers a ceiling to what is measured and refuses to raise one or add a configuration", () => {
  const shorter = sizes({ ...fixture, stable: fixture.stable.slice(5) });
  const longer = sizes({ ...fixture, volatile: `${fixture.volatile} And one more rule.` });
  const measured = { single: { ...shorter, volatile: longer.volatile }, unattended: sizes(fixture) };
  const next = lowered(baseline, measured);
  assert.deepEqual(next, { single: { stable: baseline.single.stable - 5, volatile: baseline.single.volatile, tools: baseline.single.tools } });
  // What it would not write is exactly what the check still refuses.
  const left = verify(next, measured).join("\n");
  assert.match(left, /single: the volatile half.*over its ceiling/);
  assert.match(left, /no entry for the configuration "unattended"/);
});

test("a raised or new ceiling is named, so the pull request that raised it can be asked why", () => {
  const up = { single: { ...baseline.single, tools: baseline.single.tools + 536 }, unattended: baseline.single };
  const rises = raised(up, baseline);
  assert.equal(rises.length, 4);
  assert.match(rises[0], new RegExp(`^single\\.tools rose from ${baseline.single.tools} to ${baseline.single.tools + 536} \\(\\+536\\)$`));
  assert.match(rises[1], /^unattended\.stable is new at \d+$/);
  assert.deepEqual(raised(lowered(baseline, { single: sizes({ ...fixture, stable: "" }) }), baseline), [], "lowering owes nobody a reason");
});

test("the reminder to attach a comparison appears for a change to prompt.ts or a tool's definition, and not for an unrelated one", () => {
  const [hint, ...rest] = evalHints(["src/host/prompt.ts", "src/web/server.ts"]);
  assert.deepEqual(rest, []);
  assert.match(hint, /touches what a model is sent \(src\/host\/prompt\.ts\)/);
  assert.match(hint, /\.github\/pull_request_template\.md/, "it points at the template rather than repeating it");
  assert.match(hint, /A hint, not a gate/);
  for (const path of ["src/host/tools.ts", "src/host/prompt-parts.ts", "src/host/outbox-tool.ts", "src/host/starter-skills.ts"]) assert.equal(evalHints([path]).length, 1, path);

  assert.deepEqual(evalHints(["src/web/server.ts", "docs/11-roadmap.md", "src/host/prompt.test.ts", "src/host/tool-roster.test.ts", "scripts/prompt-ratchet.mjs"]), []);
  assert.deepEqual(evalHints([]), []);
  // A raised ceiling is said whatever the files were.
  assert.match(evalHints(["prompt-baseline.json"], ["single.tools rose from 10 to 20 (+10)"])[1], /was raised: single\.tools rose from 10 to 20 \(\+10\)\. The pull request description says why/);
});
