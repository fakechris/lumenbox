#!/usr/bin/env node
/**
 * The same scenarios, against the real model, several times.
 *
 * The scripted episodes in `src/host/scenario.test.ts` prove the rails hold when a model
 * misbehaves in a named way. They cannot tell you whether the model behaves. That needs real
 * runs, and one real run tells you almost nothing — conduct varies. So this runs each scenario
 * N times against a scratch installation and prints a scorecard, and you read the columns.
 *
 * It costs money and takes minutes. It is not part of `npm test` and never will be.
 *
 *   npm run scenario                     every scenario, 3 runs each
 *   npm run scenario -- --runs 5         more runs
 *   npm run scenario -- --only team      one scenario
 *   npm run scenario -- --json out.json  the raw numbers, for a diff between builds
 *
 * A scratch AGENTBOX_HOME and a scratch box are used, so nothing here touches the live
 * installation's agents, ledgers or spend.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const flag = name => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};

/**
 * A scenario is a person's opening line and the questions a reader would ask of the run.
 * `expect` is deliberately soft: these are conduct judgements, and a red cell is a thing to
 * look at rather than a build failure.
 */
const SCENARIOS = [
  {
    name: "team",
    say: "Build me a five-agent content team: a scout, a brief writer, a drafter, a fact checker and an analyst. They share /home/box/work/content-team.",
    expect: {
      "agents created": score => score.agents.length >= 6,
      "≤1 question": score => score.questions <= 1,
      "no liveness polling": score => !/sleep \d\d/.test(JSON.stringify(score.trail)),
      "under 40 calls": score => score.trail.length < 40,
    },
  },
  {
    name: "heavy",
    say: "Go through every file under /home/box/work and tell me which three are largest and what they are.",
    expect: {
      "answered": score => score.said.length > 0,
      "machinery private": score => !/fork|delegat|dispatch|子代理/i.test(score.said.map(s => s.text).join(" ")),
      "under 25 calls": score => score.trail.length < 25,
    },
  },
  {
    name: "vague",
    say: "写点东西发出去。",
    // A vague request has no right answer, only a right shape: one clarifying move, not five,
    // and something said either way. Starting on a guess and asking once both pass.
    expect: {
      "≤1 question": score => score.questions <= 1,
      "answered or asked": score => score.said.some(part => part.text.trim() !== "") || score.questions > 0,
      "not a spiral": score => score.trail.length < 12,
    },
  },
];

async function main() {
  // The credential comes from the operator's real installation, before the scratch home is put
  // in its place: the scenario writes into a throwaway directory but must talk to the provider
  // this machine is actually configured for. Applied to the environment, never printed.
  const { loadConfig, applyConfigEnv } = await import("../src/config.ts");
  const { resolveProvider } = await import("../src/host/provider.ts");
  const realConfig = loadConfig();
  applyConfigEnv(realConfig);
  // Resolved here, from the real home, and passed down: once AGENTBOX_HOME points at the
  // scratch directory `loadConfig()` reads an empty file and the run would silently go to
  // whichever provider is the default rather than the one this machine uses.
  const provider = resolveProvider(process.env.AGENTBOX_PROVIDER ?? realConfig.provider);
  console.log(`\n  provider: ${provider.label} ${provider.model}`);

  const runs = Number(flag("--runs") ?? 3);
  const only = flag("--only");
  const chosen = only ? SCENARIOS.filter(s => s.name === only) : SCENARIOS;
  if (chosen.length === 0) {
    console.error(`No scenario called ${only}. Have: ${SCENARIOS.map(s => s.name).join(", ")}`);
    process.exit(1);
  }

  const { runEpisode } = await import("../src/host/scenario.ts");
  void runEpisode; // the live path builds its own stack below; imported to fail fast if it moved.
  const results = [];

  for (const scenario of chosen) {
    for (let run = 1; run <= runs; run += 1) {
      const home = mkdtempSync(join(tmpdir(), `lumenbox-scenario-${scenario.name}-`));
      process.env.AGENTBOX_HOME = home;
      const started = Date.now();
      let score;
      let failure;
      try {
        score = await liveEpisode(scenario, provider);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      results.push({
        scenario: scenario.name,
        run,
        seconds: Math.round((Date.now() - started) / 1000),
        ...(score !== undefined ? { score, checks: judge(scenario, score) } : { failure }),
      });
      rmSync(home, { recursive: true, force: true });
    }
  }

  report(chosen, results, runs);
  const out = flag("--json");
  if (out !== undefined) {
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    console.log(`\nRaw numbers: ${out}`);
  }
}

function judge(scenario, score) {
  return Object.fromEntries(
    Object.entries(scenario.expect).map(([label, check]) => {
      try {
        return [label, check(score) === true];
      } catch {
        return [label, false];
      }
    })
  );
}

/**
 * One live run: a real orchestrator against the real provider, in a scratch home, with the
 * installation's own box. Everything the model does is real; only the person is scripted.
 */
async function liveEpisode(scenario, provider) {
  const { Orchestrator } = await import("../src/host/orchestrator.ts");
  const { AgentRegistry } = await import("../src/agents/registry.ts");

  const registry = new AgentRegistry(join(process.env.AGENTBOX_HOME, "agents"));
  const front = registry.create({ name: "Front", description: "The person's counterpart. Route and answer.", boxId: registry.box.id });

  const trail = [];
  const said = [];
  const questions = [];
  const orchestrator = new Orchestrator({
    registry,
    provider,
    useBox: true,
    askUser: async input => {
      questions.push(input.question);
      // The person is not here: every question takes its own stated default, which is what a
      // person moving on looks like. A scenario that stalls on a question scores badly by design.
      return "in the app";
    },
    onTurnEvent: event => {
      if (event.type === "tool_start") trail.push(`${event.agentName}:${event.tool}`);
      if (event.type === "text") said.push({ agent: event.agentName, text: event.delta });
    },
  });

  // prompt() awaits the person's own turn; idle() waits for whatever it set going — a fork
  // reporting back, a teammate's reply — so the scorecard covers the whole episode.
  await orchestrator.prompt(front.id, scenario.say, { userId: "scenario" });
  await orchestrator.bus.idle();

  return {
    agents: registry.list().map(record => record.profile.name),
    trail,
    questions: questions.length,
    said: [{ agent: "Front", text: said.map(part => part.text).join("") }],
  };
}

function report(scenarios, results, runs) {
  console.log(`\n  ${runs} run(s) per scenario, ${new Date().toISOString().slice(0, 16)}\n`);
  for (const scenario of scenarios) {
    const mine = results.filter(result => result.scenario === scenario.name);
    console.log(`  ${scenario.name} — "${scenario.say.slice(0, 60)}…"`);
    const labels = Object.keys(scenario.expect);
    const width = Math.max(...labels.map(label => label.length), 10);
    for (const label of labels) {
      const passed = mine.filter(result => result.checks?.[label] === true).length;
      const bar = mine.map(result => (result.checks?.[label] === true ? "·" : "x")).join("");
      console.log(`    ${label.padEnd(width)}  ${String(passed).padStart(2)}/${mine.length}  ${bar}`);
    }
    const calls = mine.map(result => result.score?.trail.length ?? 0);
    const seconds = mine.map(result => result.seconds);
    console.log(`    ${"tool calls".padEnd(width)}  ${calls.join(", ")}`);
    console.log(`    ${"seconds".padEnd(width)}  ${seconds.join(", ")}`);
    const failed = mine.filter(result => result.failure !== undefined);
    for (const result of failed) console.log(`    run ${result.run} failed: ${result.failure}`);
    console.log("");
  }
  console.log("  x is a conduct judgement, not a broken build. Read the runs, not the total.\n");
}

await main();
