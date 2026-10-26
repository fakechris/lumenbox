#!/usr/bin/env node
/**
 * The Delegate support matrix (INV-1359): every preset, against every provider this machine has a
 * key for, through five scenarios — so "does Delegate to pi still work on this provider" is answered
 * before a release rather than by a user after it. After HarnessRouter's harness × model × scenario
 * table (research 2026-10-25).
 *
 * Scenarios, one cell each:
 *   first      a brief that writes one file; the engine's own report says done, the file exists
 *   followup   a second brief in the same directory with `session: true`: the engine resumes its
 *              own thread and extends the file (n/a for a preset with no session form)
 *   switch     a different model mid-session — n/a: Delegate carries no per-brief model; the engine
 *              uses the installation's provider model. Recorded, not run, so the gap is in the table
 *   artifact   a brief whose only deliverable is a file with exact content
 *   recycle    the host process is replaced (a fresh Orchestrator over the same home) and the
 *              follow-up still resumes the engine's thread from the persisted capsule
 *
 * The coordinator is a scripted model: it issues the Delegate calls deterministically, so the cell
 * measures the engine on the provider, not a model's choice of preset. The engine itself runs for
 * real, in the dedicated box, through the host's model relay with the provider's key.
 *
 *   AGENTBOX_CONTAINER=lumenbox-eval-box node --experimental-transform-types scripts/preset-matrix.mjs --dry-run
 *   AGENTBOX_CONTAINER=lumenbox-eval-box node --experimental-transform-types scripts/preset-matrix.mjs \
 *       --json out/matrix.json --md out/matrix.md [--only pi] [--providers minimax,kimi] [--install]
 *
 * Never part of `npm test`. Refuses the live box unless --live-box is passed.
 */
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const flag = name => {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
};
const has = name => process.argv.includes(name);
const SCENARIOS = ["first", "followup", "switch", "artifact", "recycle"];
const CELL_TIMEOUT_MS = Number(flag("--timeout") ?? 600) * 1000;
const WORK_ROOT = "/home/box/work/preset-matrix";
/** What the box is, read once from inside it: the table is only meaningful next to these. */
const boxFacts = { node: "unknown", image: "unknown" };

async function main() {
  const { PRESETS } = await import("../src/host/presets.ts");
  const only = flag("--only");
  const presets = PRESETS.filter(preset => only === undefined || preset.name === only);
  if (presets.length === 0) throw new Error(`No preset called ${only}. Have: ${PRESETS.map(p => p.name).join(", ")}`);
  const sha = (() => { try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { return "unknown"; } })();

  const { loadConfig, applyConfigEnv } = await import("../src/config.ts");
  const { resolveProvider } = await import("../src/host/provider.ts");
  const realConfig = loadConfig();
  applyConfigEnv(realConfig);
  // The providers to run: named, or the one this installation is configured for. A provider
  // whose key is not in the environment is a FAIL cell with that reason, not a silent skip.
  const providerNames = (flag("--providers") ?? realConfig.provider ?? "anthropic").split(",").map(name => name.trim()).filter(Boolean);
  const providers = providerNames.map(name => ({ name, profile: resolveProvider(name) }));

  if (flag("--from") !== undefined) {
    const { readFileSync } = await import("node:fs");
    const saved = JSON.parse(readFileSync(flag("--from"), "utf8"));
    Object.assign(boxFacts, saved.box ?? {});
    const md = render(saved.cells, providers.filter(p => saved.cells.some(c => c.provider === p.name)), saved.build);
    const out = flag("--md");
    if (out !== undefined) writeFileSync(out, md);
    console.log(md);
    return;
  }
  if (has("--dry-run")) {
    console.log(`\nbuild ${sha}; ${presets.length} preset(s) × ${providers.length} provider(s) × ${SCENARIOS.length} scenarios = ${presets.length * providers.length * SCENARIOS.length} cells (switch is recorded n/a without a run)\n`);
    for (const preset of presets) console.log(`  ${preset.name.padEnd(9)} session form: ${preset.session !== undefined || preset.acp !== undefined ? "yes" : "no"}  acp: ${preset.acp !== undefined ? "yes" : "no"}  pinned ${preset.install.version}`);
    console.log(`\nproviders: ${providers.map(p => `${p.name} (${p.profile.label} ${p.profile.model})`).join(", ")}\n`);
    return;
  }
  if (process.env.AGENTBOX_CONTAINER === undefined && !has("--live-box")) {
    throw new Error("Refusing to run against the live box. Set AGENTBOX_CONTAINER to a dedicated box, or pass --live-box to mean it.");
  }
  if (process.env.AGENTBOX_TOKEN === undefined) {
    const { loadBoxToken } = await import("../src/box/docker.ts");
    process.env.AGENTBOX_TOKEN = loadBoxToken(process.env.AGENTBOX_CONTAINER);
  }

  const cells = [];
  for (const provider of providers) {
    for (const preset of presets) {
      for (const scenario of SCENARIOS) {
        const label = `${preset.name} × ${provider.name} × ${scenario}`;
        process.stdout.write(`  ${label.padEnd(40)}`);
        const started = Date.now();
        let cell;
        try {
          cell = await runCell(preset, provider, scenario);
        } catch (error) {
          cell = { result: "FAIL", reason: `harness: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}` };
        }
        cell.preset = preset.name;
        cell.provider = provider.name;
        cell.model = provider.profile.model;
        cell.scenario = scenario;
        cell.seconds = Math.round((Date.now() - started) / 1000);
        cells.push(cell);
        console.log(`${cell.result}${cell.reason ? ` — ${cell.reason}` : ""} (${cell.seconds}s)`);
      }
    }
  }
  const md = render(cells, providers, sha);
  console.log(`\n${md}`);
  for (const [name, text] of [["--json", JSON.stringify({ at: new Date().toISOString(), build: sha, box: boxFacts, cells }, null, 2)], ["--md", md]]) {
    const out = flag(name);
    if (out === undefined) continue;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
  }
}

/** One cell. A scratch home per cell; the box directory is the cell's own and is removed after. */
async function runCell(preset, provider, scenario) {
  if (scenario === "switch") return { result: "n/a", reason: "Delegate carries no per-brief model; the engine uses the installation's provider model" };
  const hasSession = preset.session !== undefined || preset.acp !== undefined;
  if ((scenario === "followup" || scenario === "recycle") && !hasSession) return { result: "n/a", reason: `${preset.name} has no session form` };

  const home = mkdtempSync(join(tmpdir(), `lumenbox-matrix-${preset.name}-${scenario}-`));
  process.env.AGENTBOX_HOME = home;
  const slug = `${preset.name}-${scenario}-${Math.random().toString(16).slice(2, 8)}`;
  const workdir = `${WORK_ROOT}/${slug}`;
  const file = scenario === "artifact" ? "report.md" : "hello.txt";
  const briefs = {
    first: `Create the file ${workdir}/${file} containing exactly the single line PONG. Do nothing else, then report done.`,
    artifact: `Write ${workdir}/${file} with exactly these three lines and nothing else:\n# Report\nstatus: green\ncount: 42\nThen report done.`,
    followup: `Create the file ${workdir}/${file} containing exactly the single line PONG. Remember this file: a follow-up will ask you about it. Report done.`,
    recycle: `Create the file ${workdir}/${file} containing exactly the single line PONG. Remember this file: a follow-up will ask you about it. Report done.`,
  };
  // The follow-up names nothing: the engine has to know which file from its own thread.
  const followBrief = `Add one more line to the file you created earlier in this directory. The new line's text is exactly: SECOND\nDo not recreate the file and do not ask which file it is. Then report done.`;

  let openHosts = [];
  try {
    const session = await openHost(provider, home);
    openHosts.push(session);
    await session.sh(`mkdir -p ${JSON.stringify(workdir)}`);
    if (boxFacts.node === "unknown") {
      boxFacts.node = (await session.sh("node --version")).stdout.trim() || "unknown";
      boxFacts.image = (await session.sh("cat /etc/lumenbox/contract.json 2>/dev/null")).stdout.replace(/\s+/g, " ").trim() || "unknown";
    }
    const installed = await ensureInstalled(session, preset, workdir);
    if (installed !== undefined) return { result: "FAIL", reason: installed };
    const first = await delegateAndWait(session, preset, briefs[scenario], workdir, {});
    if (first.verdict !== "done") return { result: "FAIL", reason: first.reason, usage: session.usage() };
    const expectOne = scenario === "artifact" ? "# Report\nstatus: green\ncount: 42" : "PONG";
    const content = (await session.sh(`cat ${JSON.stringify(`${workdir}/${file}`)} 2>/dev/null`)).stdout.trim();
    if (content !== expectOne) return { result: "FAIL", reason: `file is ${JSON.stringify(content.slice(0, 60))}, wanted ${JSON.stringify(expectOne)}`, usage: session.usage() };
    if (scenario === "first" || scenario === "artifact") return { result: "pass", reason: first.reason, usage: session.usage() };

    // followup / recycle: the second brief must land in the same engine thread.
    const host = scenario === "recycle" ? await (async () => { await session.close(); const next = await openHost(provider, home); openHosts.push(next); return next; })() : session;
    const second = await delegateAndWait(host, preset, followBrief, workdir, { session: true });
    const after = (await host.sh(`cat ${JSON.stringify(`${workdir}/${file}`)} 2>/dev/null`)).stdout.trim();
    const usage = host.usage();
    if (second.verdict !== "done") return { result: "FAIL", reason: `follow-up: ${second.reason}`, usage };
    if (after !== "PONG\nSECOND") return { result: "FAIL", reason: `after follow-up the file is ${JSON.stringify(after.slice(0, 60))}, wanted PONG\\nSECOND${second.resumed ? "" : " (the engine did not resume its thread)"}`, usage };
    return { result: "pass", reason: second.resumed ? "resumed the engine's thread" : "done", usage };
  } finally {
    for (const h of openHosts) { try { await h.close(); } catch { /* already closed */ } }
    if (has("--keep")) console.log(`\n  (kept ${home})`);
    else rmSync(home, { recursive: true, force: true });
  }
}

/**
 * A host over `home`: a scratch registry, one agent, a scripted coordinator, the real box and the
 * real provider for the engine's relay. `close()` lets a later `openHost` over the same home stand
 * in for a process restart.
 */
async function openHost(provider, home) {
  const { Orchestrator } = await import("../src/host/orchestrator.ts");
  const { AgentRegistry } = await import("../src/agents/registry.ts");
  const { fakeModel } = await import("../src/host/testing/fake-model.ts");
  const registry = new AgentRegistry(join(home, "agents"));
  const front = registry.list()[0] ?? registry.create({ name: "Front", description: "Delegates and acknowledges.", boxId: registry.box.id });
  const usage = [];
  const notes = [];
  /** What the scripted coordinator does next; set per delegation by delegateAndWait. */
  let pendingCall;
  const client = fakeModel(({ params }) => {
    const last = params.messages.at(-1);
    const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    const ended = /\[A job you delegated (?:finished|failed|was stopped before it finished|ended, and whether it did the work is unknown)[^\]]*\]/.exec(text);
    if (ended !== null) notes.push(ended[0]);
    if (pendingCall !== undefined) {
      const call = pendingCall;
      pendingCall = undefined;
      return { id: "msg", type: "message", role: "assistant", model: provider.profile.model, stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: `toolu_${Math.random().toString(16).slice(2, 10)}`, name: "Delegate", input: call }] };
    }
    return { id: "msg", type: "message", role: "assistant", model: provider.profile.model, stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: "ack" }] };
  });
  const orchestrator = new Orchestrator({
    registry,
    provider: provider.profile,
    client,
    useBox: true,
    askUser: async () => "proceed",
    onTurnEvent: event => { if (event.type === "usage") usage.push(event); },
  });
  const connected = await orchestrator.connectBox();
  if (!connected.connected) throw new Error(`box: ${connected.detail}`);
  // The engine in the box reaches its model (and submits its report) through this host, so the
  // harness serves the two routes the web server would: the model relay and the MCP face.
  const server = await serveHostRoutes(orchestrator);
  await orchestrator.reattachSessions();
  const box = orchestrator.boxFor(front.id);
  const sh = async command => {
    const result = await box.exec(command, { timeoutMs: 60_000, actor: "matrix" });
    return { code: result.exit_code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return {
    orchestrator, front, registry, notes, sh,
    delegate: call => { pendingCall = call; },
    usage: () => ({ calls: usage.length, tokens: usage.reduce((n, u) => n + u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens, 0) }),
    close: async () => { await orchestrator.settle(); await new Promise(resolve => server.close(resolve)); },
  };
}

/** The relay and face routes on an ephemeral port, addressed the way the web server would address them. */
async function serveHostRoutes(orchestrator) {
  const { RELAY_PATH } = await import("../src/host/model-relay.ts");
  const { ROUTE_PATH, faceBaseUrl } = await import("../src/host/mcp-face.ts");
  const { handleMcpRequest } = await import("../src/web/mcp-server.ts");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://matrix");
    const relayMatch = RELAY_PATH.exec(url.pathname);
    if (relayMatch !== null) {
      const route = orchestrator.modelRelay.authenticate(relayMatch[1], req.headers);
      if (route === undefined) { res.writeHead(401).end(); return; }
      await orchestrator.modelRelay.proxy(req, res, route, relayMatch[2] ?? "/");
      return;
    }
    const routeMatch = ROUTE_PATH.exec(url.pathname);
    if (routeMatch !== null) {
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim();
      const route = orchestrator.mcpFace.authenticate(routeMatch[1], bearer);
      await handleMcpRequest(req, res, { path: url.pathname, serverName: "lumenbox-face", tools: route === undefined ? [] : orchestrator.mcpFace.toolsFor(route), principalFor: () => route?.agentId, log: () => {} });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
  const port = server.address().port;
  orchestrator.mcpFace.baseUrl = faceBaseUrl(port);
  orchestrator.modelRelay.baseUrl = faceBaseUrl(port);
  const sweep = setInterval(() => { orchestrator.modelRelay.sweep(); void orchestrator.mcpFace.renew(); }, 60_000);
  sweep.unref();
  return server;
}

/**
 * The engine must be in the box. Without --install a missing one is the cell's reason; with it,
 * Delegate's own install job runs (the pinned version, on the work volume) and the cell waits.
 */
async function ensureInstalled(host, preset, cwd) {
  if ((await host.sh(preset.probe)).code === 0) return undefined;
  if (!has("--install")) return `engine not installed in the box (${preset.install.package} ${preset.install.version}); pass --install`;
  process.stdout.write(`installing ${preset.install.package} ${preset.install.version}… `);
  host.delegate({ preset: preset.name, prompt: "install", cwd, install: true });
  await host.orchestrator.prompt(host.front.id, `Install ${preset.name}.`, { userId: "matrix" });
  const started = /Installing [a-z]+ [0-9.]+ into the box as (job-[0-9a-f]+) \(log: ([^)]+)\)/.exec(JSON.stringify(host.registry.readTranscript(host.front.id)));
  if (started === null) return `install was not started: ${JSON.stringify(host.registry.readTranscript(host.front.id)).slice(-200)}`;
  const [, jobId, log] = started;
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10_000));
    if ((await host.sh(preset.probe)).code === 0) return undefined;
    const rc = (await host.sh(`cat ${JSON.stringify(log.replace(/\.log$/, ".rc"))} 2>/dev/null`)).stdout.trim();
    if (rc !== "" && rc !== "0") {
      const tail = (await host.sh(`tail -n 12 ${JSON.stringify(log)}`)).stdout.replace(/\s+/g, " ").trim();
      return `install job ${jobId} exited ${rc}: ${tail.slice(0, 200)}`;
    }
  }
  return `install of ${preset.install.package} ${preset.install.version} did not finish within 15 minutes`;
}

/** Issues one Delegate through the scripted coordinator and waits for the job's own ending note. */
async function delegateAndWait(host, preset, brief, cwd, extra) {
  const before = host.notes.length;
  host.delegate({ preset: preset.name, prompt: brief, cwd, ...(extra.session ? { session: true } : {}), ...(extra.install ? { install: true } : {}) });
  await host.orchestrator.prompt(host.front.id, `Delegate this to ${preset.name}: ${brief.split("\n")[0].slice(0, 80)}`, { userId: "matrix" });
  // The Delegate tool's own refusal (engine missing, no session form) is in the transcript, not a note.
  const transcript = () => JSON.stringify(host.registry.readTranscript(host.front.id));
  const refusal = /(engine is not in this box|speaks only the [^,]+ model API|has no session form|Installing [a-z]+ [0-9.]+ into the box|unknown preset)[^"\\]{0,160}/i.exec(transcript());
  if (refusal !== null && host.notes.length === before) return { verdict: "failed", reason: refusal[0].slice(0, 160) };
  const deadline = Date.now() + CELL_TIMEOUT_MS;
  // The web server's renewal tick is what notices a finished delegation; the harness ticks itself.
  while (host.notes.length === before && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2_000));
    await host.orchestrator.mcpFace.renew();
    await host.orchestrator.sweepDelegates().catch(() => {});
  }
  if (host.notes.length === before) {
    const tail = transcript().slice(-600);
    if (has("--verbose")) console.log(`\n  transcript tail: ${tail}`);
    return { verdict: "timeout", reason: `no ending note within ${CELL_TIMEOUT_MS / 1000}s` };
  }
  await host.orchestrator.bus.idle();
  const note = host.notes.at(-1);
  const verdict = /^\[A job you delegated finished/.test(note) ? "done" : /^\[A job you delegated failed/.test(note) ? "failed" : /stopped/.test(note) ? "aborted" : "unknown";
  // The note names the job and brief, then says why in a sentence; that sentence is the reason.
  const why = /^\[A job you delegated [^:]*: job-[0-9a-f]+ \([^)]*\)\. ([\s\S]*?)(?: Read its| Do not use| What it left|\]$)/.exec(note)?.[1] ?? note.slice(0, 200);
  return { verdict, reason: verdict === "done" ? "engine reported done" : `${verdict}: ${why.replace(/\s+/g, " ").slice(0, 200)}`, resumed: /resumes the thread from this conversation/.test(transcript()) };
}

function render(cells, providers, sha) {
  const lines = [`## Delegate support matrix — ${new Date().toISOString().slice(0, 10)}, build ${sha}`, "", `Box: node ${boxFacts.node}; image contract: ${boxFacts.image}`, ""];
  for (const provider of providers) {
    lines.push(`### Provider: ${provider.name} (${provider.profile.label}, ${provider.profile.model})`, "");
    lines.push(`| preset | ${SCENARIOS.join(" | ")} | notes |`, `|---|${SCENARIOS.map(() => "---").join("|")}|---|`);
    const presets = [...new Set(cells.filter(c => c.provider === provider.name).map(c => c.preset))];
    for (const preset of presets) {
      const row = SCENARIOS.map(s => cells.find(c => c.provider === provider.name && c.preset === preset && c.scenario === s));
      // One note per distinct reason, naming the scenarios it covers; the per-cell text is in the JSON.
      const byReason = new Map();
      for (const c of row.filter(c => c && c.result !== "pass")) {
        const reason = c.reason.replace(/\s+/g, " ").replace(/job-[0-9a-f]+ /, "").slice(0, 220);
        byReason.set(reason, [...(byReason.get(reason) ?? []), c.scenario]);
      }
      const notes = [...byReason].map(([reason, scenarios]) => `${scenarios.join("/")}: ${reason}`).join(" · ");
      lines.push(`| ${preset} | ${row.map(c => (c ? (c.result === "pass" ? `pass (${c.seconds}s)` : c.result === "n/a" ? "n/a" : `**FAIL**`) : "—")).join(" | ")} | ${notes} |`);
    }
    lines.push("");
  }
  lines.push("pass = the engine's own report said done and the file is as asked; n/a = the scenario does not apply to the preset, with the reason in notes; FAIL = the reason in notes.");
  return lines.join("\n");
}

await main();
