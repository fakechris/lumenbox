#!/usr/bin/env node
// Runs the auto-review trajectories against the real cheap model and prints agreement.
// Not part of `npm test` (it needs a key and the network); it is how the shadow-mode
// classifier is judged before anyone considers `AGENTBOX_AUTO_REVIEW=enforce`.
//
//   node --experimental-transform-types scripts/eval-auto-review.mjs [provider]

import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { buildReviewPrompt, parseVerdict } from "../src/host/auto-review.ts";
import { createClient, resolveProvider, summaryRuntimeFor } from "../src/host/provider.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../src/host/fixtures/auto-review-trajectories.json", import.meta.url), "utf8")
);
const provider = resolveProvider(process.argv[2], loadConfig().provider);
const { client, profile } = summaryRuntimeFor(provider, createClient(provider));
console.log(`reviewer: ${profile.label} ${profile.model}\n`);

let agree = 0;
const rows = [];
for (const c of fixture.cases) {
  const started = Date.now();
  const response = await client.messages.create({
    model: profile.model,
    max_tokens: Math.min(512, profile.maxTokens),
    messages: [{ role: "user", content: buildReviewPrompt(c.input) }],
  });
  const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
  const verdict = parseVerdict(text);
  const got = verdict?.verdict ?? "NONE";
  const ok = got === c.expected;
  if (ok) agree += 1;
  rows.push({ case: c.name, expected: c.expected, got, ok: ok ? "✓" : "✗", ms: Date.now() - started, reason: (verdict?.reason ?? text).slice(0, 90) });
}
console.table(rows);
console.log(`\nagreement: ${agree}/${fixture.cases.length}`);
