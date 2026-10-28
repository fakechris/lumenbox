#!/usr/bin/env node
/**
 * How often the decision model agreed with each point's own path, from the shadow log (INV-1415).
 *
 *   node scripts/jev-shadow-report.mjs [path]     default ~/.agentbox/jev-shadow.jsonl
 *
 * Per point: how many comparisons, how many the decision model failed, the agreement rate, and up
 * to ten disagreements as the log recorded them (verdicts and digests; the log never holds text).
 * This is the evidence a switch is moved from shadow to on with — or, for the authorisation review,
 * the evidence that it never should be.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The part of a summary that is the decision: "PASS@0.91" → "PASS", {verdict} → verdict. */
function decisionOf(value) {
  if (typeof value === "string") return value.split("@")[0];
  if (value !== null && typeof value === "object" && !Array.isArray(value) && "verdict" in value) return String(value.verdict);
  return JSON.stringify(value);
}

/** 1 for the same decision, 0 for a different one; for selections, the overlap of the two sets. */
export function agreement(own, jev) {
  if (Array.isArray(own) && Array.isArray(jev) && [...own, ...jev].every(item => typeof item === "number")) {
    const a = new Set(own);
    const b = new Set(jev);
    const union = new Set([...a, ...b]);
    return union.size === 0 ? 1 : [...a].filter(item => b.has(item)).length / union.size;
  }
  if (Array.isArray(own) && Array.isArray(jev)) {
    // The memory judge: one line per candidate, "question=y0.90 …"; compare each question's yes/no.
    let same = 0;
    let total = 0;
    own.forEach((line, i) => {
      const theirs = String(jev[i] ?? "").split(" ");
      String(line).split(" ").forEach((answer, j) => {
        total += 1;
        if (answer.split("=")[1]?.[0] === theirs[j]?.split("=")[1]?.[0]) same += 1;
      });
    });
    return total === 0 ? 1 : same / total;
  }
  return decisionOf(own) === decisionOf(jev) ? 1 : 0;
}

export function report(lines) {
  const byPoint = new Map();
  for (const line of lines) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const row = byPoint.get(entry.point) ?? { compared: 0, failed: 0, agreement: 0, disagreements: [] };
    if (entry.error !== undefined || entry.jev === undefined) row.failed += 1;
    else {
      row.compared += 1;
      const score = agreement(entry.own, entry.jev);
      row.agreement += score;
      if (score < 1 && row.disagreements.length < 10) row.disagreements.push({ at: entry.at, own: entry.own, jev: entry.jev });
    }
    byPoint.set(entry.point, row);
  }
  return [...byPoint.entries()].map(([point, row]) => ({
    point,
    compared: row.compared,
    failed: row.failed,
    agreement: row.compared === 0 ? null : Number((row.agreement / row.compared).toFixed(3)),
    disagreements: row.disagreements,
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? join(process.env.AGENTBOX_HOME ?? join(homedir(), ".agentbox"), "jev-shadow.jsonl");
  if (!existsSync(path)) {
    console.log(`No shadow log at ${path}. Set a point to shadow in Settings → Model → Decision model first.`);
    process.exit(0);
  }
  for (const row of report(readFileSync(path, "utf8").split("\n"))) {
    console.log(`${row.point}: ${row.compared} compared, ${row.failed} failed, agreement ${row.agreement ?? "—"}`);
    for (const d of row.disagreements) console.log(`  ${d.at}  own ${JSON.stringify(d.own)}  model ${JSON.stringify(d.jev)}`);
  }
}
