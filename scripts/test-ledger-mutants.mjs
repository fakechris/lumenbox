/** Negative controls for the recovery tests. Mutations run only in disposable copies. */
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { hermeticEnv } from "./test-env.mjs";

const source = fileURLToPath(new URL("../", import.meta.url));
const mutants = [
  { name: "close-before-resume-admission", file: "src/host/orchestrator.ts", from: "this.bus.sendFromUser(agent.id, resumePrompt(turn.about, turn.at), {", to: 'this.turns?.end(turn.id, "resumed"); this.bus.sendFromUser(agent.id, resumePrompt(turn.about, turn.at), {', test: "src/host/admission-handoff.test.ts" },
  { name: "start-steering-before-record", file: "src/agents/bus.ts", from: "record?.(taken);", to: "this.inbox?.start(taken.map(message => message.admission)); record?.(taken);", test: "src/host/admission-handoff.test.ts" },
  { name: "dispatch-without-checkpoint", file: "src/host/resume.ts", from: 'this.append({ turnId, event: "pending", toolUseId, name, at: now.toISOString() }, true);', to: 'this.append({ turnId, event: "pending", toolUseId, name, at: now.toISOString() });', test: "src/host/ledger-faults.test.ts" },
  { name: "start-before-custody", file: "src/agents/bus.ts", from: "if (!this.deferredStart) acknowledge();", to: "acknowledge();", test: "src/host/admission-handoff.test.ts" },
  { name: "skip-turn-begin", file: "src/host/turn.ts", from: "deps.turns?.begin({", to: "false && deps.turns?.begin({", test: "src/host/admission-handoff.test.ts" },
  { name: "lose-principal", file: "src/agents/bus.ts", from: "...(options.principalId !== undefined ? { principalId: options.principalId } : {}),", to: "", test: "src/host/admission-handoff.test.ts" },
  { name: "replay-unknown-effect", file: "src/host/turn.ts", from: "safeToReplay(call.name, input) || replaysToSameState(call.name, input)", to: "true", test: "src/host/resume-integration.test.ts" },
  { name: "settle-before-delivery", file: "src/host/pending-work.ts", from: "if (!admitted) continue;", to: "if (false) continue;", test: "src/host/ledger-faults.test.ts" },
];

function run(root, test) {
  const result = spawnSync(process.execPath, ["--experimental-transform-types", "--import", "./scripts/test-network-guard.mjs",
    "--test", "--test-reporter=tap", "--test-timeout=45000", test],
  { cwd: root, env: hermeticEnv(), encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return { ...result, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

for (const test of new Set(mutants.map(m => m.test))) {
  const baseline = run(source, test);
  if (baseline.status !== 0 || !/# fail 0\b/.test(baseline.output)) {
    process.stderr.write(baseline.output);
    throw new Error(`Baseline failed: ${test}`);
  }
  console.log(`BASELINE PASS ${test}`);
}
for (const mutant of mutants) {
  const root = mkdtempSync(join(tmpdir(), "ledger-mutant-"));
  try {
    for (const path of ["src", "scripts", "package.json"]) cpSync(join(source, path), join(root, path), { recursive: true });
    symlinkSync(join(source, "node_modules"), join(root, "node_modules"), "dir");
    const path = join(root, mutant.file);
    const text = readFileSync(path, "utf8");
    if (!text.includes(mutant.from)) throw new Error(`Mutation anchor missing: ${mutant.name}`);
    writeFileSync(path, text.replaceAll(mutant.from, mutant.to));
    const result = run(root, mutant.test);
    // A loader error, timeout or crash is not proof that an invariant detector worked.
    if (result.status !== 1 || !/ERR_ASSERTION/.test(result.output) || !/# fail [1-9]/.test(result.output)) {
      process.stderr.write(result.output);
      throw new Error(`Mutant not rejected by an assertion: ${mutant.name}`);
    }
    console.log(`MUTANT REJECTED ${mutant.name}: ${result.output.match(/# fail \d+/)?.[0]}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
