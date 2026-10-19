#!/usr/bin/env node
// Runs the context steward's decision prompt over hand-labelled conversation endings against the
// real cheap model and prints agreement (INV-1190). Not part of `npm test`: it needs a key and the
// network. The steward only ever *suggests* a fresh context, so a wrong "switch" costs one
// suggestion message; a wrong "compact" costs nothing but a missed suggestion.
//
//   node --experimental-transform-types scripts/steward-eval.mjs [provider]

import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { STEWARD_SYSTEM, parseStewardDecision } from "../src/host/context-steward.ts";
import { createClient, resolveProvider, summaryRuntimeFor } from "../src/host/provider.ts";

const fixture = JSON.parse(readFileSync(new URL("../src/host/fixtures/steward-tails.json", import.meta.url), "utf8"));
const provider = resolveProvider(process.argv[2], loadConfig().provider);
const { client, profile } = summaryRuntimeFor(provider, createClient(provider));
console.log(`steward: ${profile.label} ${profile.model}\n`);

let agree = 0;
let input = 0;
let output = 0;
const rows = [];
for (const c of fixture.cases) {
  const started = Date.now();
  const response = await client.messages.create({
    model: profile.model,
    max_tokens: Math.min(600, profile.maxTokens),
    system: STEWARD_SYSTEM,
    messages: [{ role: "user", content: `Condensed so far: ${c.condensed} time${c.condensed === 1 ? "" : "s"}.\n\nLatest messages, oldest first:\n${c.view}` }],
  });
  input += response.usage?.input_tokens ?? 0;
  output += response.usage?.output_tokens ?? 0;
  const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
  const got = parseStewardDecision(text) ?? "NONE";
  const ok = got === c.expected;
  if (ok) agree += 1;
  rows.push({ case: c.name, expected: c.expected, got, ok: ok ? "✓" : "✗", ms: Date.now() - started });
}
console.table(rows);
const wrongSwitch = rows.filter(row => row.expected === "compact" && row.got === "switch").length;
console.log(`\nagreement: ${agree}/${fixture.cases.length}; wrong "switch" (a needless suggestion): ${wrongSwitch}; tokens in/out: ${input}/${output}`);
