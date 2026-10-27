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
 *   npm run scenario -- --skills         each starter skill's own cases (INV-693): is it opened
 *                                        when it should be, and left alone when it should not
 *   npm run scenario -- --skills --only research-brief --runs 1
 *   npm run scenario -- --skills --kind trigger     only the "should open it" cases
 *   npm run scenario -- --teach          teach evals (INV-1369): synthetic demonstrations → the
 *                                        teaching turn → deterministic checks on the draft
 *   npm run scenario -- --teach --fake   the same with each fixture's reference answer: no model
 *   … --material <dir>                   also write learning material (INV-1377): tasks/<id>.json +
 *                                        index.jsonl, for `agentbox skills improve`
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
  if (process.argv.includes("--skills")) {
    await skillEvals(provider, runs, only);
    return;
  }
  if (process.argv.includes("--teach")) {
    await teachEvals(provider, runs, only);
    return;
  }
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
  await writeLearningMaterial(results.map(result => {
    const scenario = chosen.find(s => s.name === result.scenario);
    const failing = Object.entries(result.checks ?? {}).filter(([, ok]) => !ok).map(([label]) => label);
    return {
      id: `${result.scenario}-${result.run}`,
      source: "scenario",
      input: scenario?.say ?? result.scenario,
      ...(result.score !== undefined ? { output: result.score.said.map(part => part.text).join("\n"), tools: result.score.trail.map(step => String(step.tool ?? step.name ?? step)) } : {}),
      passed: result.score !== undefined && failing.length === 0,
      feedback: result.failure ?? (failing.length > 0 ? `failed: ${failing.join(", ")}` : "every check passed"),
    };
  }));
  const out = flag("--json");
  if (out !== undefined) {
    // Provider and model travel with the numbers: the release scorecard compares two runs
    // only when they came from the same wire (INV-130), and it has to be able to tell.
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), provider: provider.label, model: provider.model, runs, results }, null, 2));
    console.log(`\nRaw numbers: ${out}`);
  }
}

/**
 * Each starter's own cases against the real model (INV-693, src/host/skill-evals.ts).
 *
 * The real turn, prompt and skills index, with every starter present at its box path and an
 * in-memory box — no Docker, nothing live touched. A case is judged on one fact: did the agent
 * open that skill's SKILL.md. The model is capped at a few calls per case, because the choice to
 * open a skill comes first and the rest of the work is not what is being measured.
 */
async function skillEvals(provider, runs, only) {
  const { runEpisode } = await import("../src/host/scenario.ts");
  const { starterSkillsWithEvals } = await import("../src/host/starter-skills.ts");
  const { parseSkillFile, skillFrom, SKILLS_DIR } = await import("../src/host/skills.ts");
  const { filesRead, judgeSkillEval } = await import("../src/host/skill-evals.ts");
  const { fakeModel } = await import("../src/host/testing/fake-model.ts");
  const { createClient } = await import("../src/host/provider.ts");
  const real = createClient(provider);
  const cap = Number(flag("--calls") ?? 4);

  const starters = starterSkillsWithEvals();
  const skills = starters.map(starter => {
    const made = skillFrom(starter.slug, parseSkillFile(starter.content));
    if (!("skill" in made)) throw new Error(`${starter.slug}: ${made.problem}`);
    return made.skill;
  });
  const skillFiles = Object.fromEntries(starters.map(starter => [`${SKILLS_DIR}/${starter.slug}/SKILL.md`, starter.content]));
  // An absent --kind means both; a --kind with no value or an unknown one is a mistake, and
  // running everything or nothing in its place would read as a result.
  const kind = process.argv.includes("--kind") ? flag("--kind") : undefined;
  if (process.argv.includes("--kind") && kind !== "trigger" && kind !== "no-trigger") {
    console.error(`--kind needs trigger or no-trigger, not ${kind ?? "nothing"}.`);
    process.exit(1);
  }
  const chosen = only ? starters.filter(starter => starter.slug === only) : starters;
  if (chosen.length === 0) {
    console.error(`No starter called ${only}.`);
    process.exit(1);
  }

  const rows = [];
  for (const starter of chosen) {
    const path = `${SKILLS_DIR}/${starter.slug}/SKILL.md`;
    for (const one of starter.evals.filter(item => kind === undefined || item.kind === kind)) {
      const verdicts = [];
      const opened = new Set();
      for (let run = 1; run <= runs; run += 1) {
        if (one.na !== undefined) { verdicts.push("na"); continue; }
        let calls = 0;
        // Whether the model answered at all. A run where it never did has not tested the
        // description, and must not score — least of all as a no-trigger "pass".
        let answered = false;
        // The real model behind the fake's stream surface, cut after `cap` calls with a quiet end.
        const client = fakeModel(async ({ params }) => {
          calls += 1;
          if (calls > cap) {
            return { id: "cut", type: "message", role: "assistant", model: provider.model, content: [{ type: "text", text: "(cut: the choice was already made)" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
          }
          answered = true;
          // Streamed, as the turn itself does: the SDK refuses a non-streaming request at the
          // turn's max_tokens.
          return real.messages.stream(params).finalMessage();
        });
        const home = mkdtempSync(join(tmpdir(), `lumenbox-skill-eval-${starter.slug}-`));
        process.env.AGENTBOX_HOME = home;
        try {
          const result = await runEpisode({
            team: [{ name: "Nova" }],
            says: [one.says],
            skills,
            files: { ...skillFiles, ...(one.files ?? {}) },
            client,
            provider,
          });
          const front = result.registry.list()[0];
          const transcript = result.registry.readTranscript(front.id);
          const read = filesRead(transcript);
          for (const file of read) if (file.startsWith(`${SKILLS_DIR}/`) && file.endsWith("/SKILL.md")) opened.add(file.split("/").at(-2));
          const modelSpoke = answered && transcript.some(entry => entry.role === "assistant");
          if (process.argv.includes("--trail")) {
            const uses = transcript.flatMap(entry => (entry.kind === "blocks" ? entry.blocks : []))
              .filter(block => block.type === "tool_use")
              .map(block => `${block.name}${block.input?.path ? `(${block.input.path})` : block.input?.command ? `(${String(block.input.command).slice(0, 60)})` : ""}`);
            const last = transcript.filter(entry => entry.role === "assistant" && typeof entry.text === "string").at(-1)?.text ?? "";
            console.log(`    [${starter.slug} / ${one.name}] ${uses.join(" → ") || "(no tools)"}${last ? ` | said: ${last.slice(0, 120).replace(/\s+/g, " ")}` : ""}`);
          }
          verdicts.push(modelSpoke ? judgeSkillEval(one, path, read) : "infra");
          result.cleanup();
        } catch (error) {
          verdicts.push("infra");
          opened.add(`error: ${error instanceof Error ? error.message.slice(0, 80) : String(error)}`);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      }
      rows.push({ skill: starter.slug, case: one.name, kind: one.kind, instead: one.instead, says: one.says, verdicts, opened: [...opened] });
    }
  }

  await writeLearningMaterial(rows.map(row => {
    const scored = row.verdicts.filter(v => v === "pass" || v === "fail");
    const passes = row.verdicts.filter(v => v === "pass").length;
    const openedIt = row.opened.includes(row.skill);
    return {
      id: `${row.skill}--${row.case}`.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120),
      source: "skill-eval",
      input: row.says,
      output: `skills opened: ${row.opened.join(", ") || "none"}`,
      passed: scored.length > 0 && passes === scored.length,
      feedback: row.kind === "trigger"
        ? `This request should have opened ${row.skill}; it passed ${passes}/${row.verdicts.length} run(s)${openedIt ? "" : " and was never opened"}.`
        : `This request should not have opened ${row.skill}${row.instead ? ` (${row.instead} fits instead)` : ""}; it passed ${passes}/${row.verdicts.length} run(s).`,
      skill: { slug: row.skill },
    };
  }));
  console.log(`\n  skill evals — ${runs} run(s) per case, at most ${cap} model calls each\n`);
  for (const row of rows) {
    const bar = row.verdicts.map(v => (v === "pass" ? "·" : v === "na" ? "-" : v === "infra" ? "!" : "x")).join("");
    const passed = row.verdicts.filter(v => v === "pass").length;
    const also = row.opened.filter(slug => slug !== row.skill);
    console.log(
      `  ${row.skill.padEnd(22)} ${row.kind.padEnd(10)} ${String(passed).padStart(2)}/${row.verdicts.length} ${bar.padEnd(5)} ${row.case}` +
        (also.length > 0 ? `   (opened: ${also.join(", ")})` : "") +
        (row.instead !== undefined ? `   [belongs to ${row.instead}]` : "")
    );
  }
  console.log("\n  · pass   x fail   - N/A (never a pass)   ! the model never answered [infra] (never a pass).\n  Tag each x [agent] (fix the description) or [infra] (fix the case).\n");
  const out = flag("--json");
  if (out !== undefined) {
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), provider: provider.label, model: provider.model, runs, cap, rows }, null, 2));
    console.log(`Raw: ${out}`);
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

/** Teach evals (INV-1369): the real teaching cue, the real model (or --fake), scored by teach-evals.ts. */
async function teachEvals(provider, runs, only) {
  const { runTeachEvals, renderTeachScorecard } = await import("../src/host/teach-evals.ts");
  const { TEACH_MAX_TOKENS } = await import("../src/host/teach.ts");
  const fake = process.argv.includes("--fake");
  let generate;
  if (fake) {
    generate = async (_cue, fixture) => fixture.reference;
  } else {
    const { createClient } = await import("../src/host/provider.ts");
    const client = createClient(provider);
    // The same call the orchestrator makes for a teaching draft: one user message, no tools.
    generate = async cue => {
      const response = await client.messages.create({ model: provider.model, max_tokens: Math.min(TEACH_MAX_TOKENS, provider.maxTokens), messages: [{ role: "user", content: cue }] });
      return response.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    };
  }
  const rows = await runTeachEvals(generate, { runs: fake ? 1 : runs, ...(only !== undefined ? { only } : {}) });
  console.log(`\nteach evals — ${fake ? "reference answers (--fake)" : `${provider.label} ${provider.model}`}, ${fake ? 1 : runs} run(s) each\n`);
  console.log(renderTeachScorecard(rows));
  const out = flag("--json");
  if (out !== undefined) writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), model: fake ? "reference" : provider.model, rows }, null, 2));
  await writeLearningMaterial(rows.map(row => ({
    id: `teach-${row.fixture}-${row.run}`,
    source: "teach-eval",
    input: `the demonstration "${row.fixture}"`,
    passed: row.passed,
    // The names of the checks that failed and their findings; never the fixture's expectations.
    feedback: row.failure ?? (row.checks.filter(c => !c.ok).map(c => `${c.name}${c.detail ? `: ${c.detail}` : ""}`).join("; ") || "all checks passed"),
  })));
  if (fake && rows.some(row => !row.passed)) process.exitCode = 1;
}

/** Learning material (INV-1377) from whichever mode ran; written only when --material names a directory. */
async function writeLearningMaterial(tasks) {
  const dir = flag("--material");
  if (dir === undefined) return;
  const { writeMaterial } = await import("../src/host/learning-material.ts");
  writeMaterial(dir, tasks);
  console.log(`\n  learning material: ${tasks.length} task(s) in ${dir}`);
}
