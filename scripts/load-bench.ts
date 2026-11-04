/**
 * Load benchmark: what the host holds while agents' work in a box grows (INV-1559).
 *
 * The real orchestrator — registry, bus, turns, tools, the job watch — drives a real, disposable box
 * container; only the model is scripted. Each of N agents runs M shell commands that print steadily
 * and outlive the foreground window, so they are adopted as jobs and watched, and each ending wakes
 * the agent, as it did on 2026-11-04. A separate idle agent is asked to reply every few seconds; how
 * long that takes is the turn latency a person would feel.
 *
 * Every SAMPLE_MS it records the host's heap and RSS, the box cgroup's memory and CPU, the watched
 * jobs and turns in flight, and the transcripts' size on disk, into a TSV. With --snapshots it also
 * writes heap snapshots at the start, at peak load and at the end, and sums each by constructor so the
 * structures that grew can be named.
 *
 * Not part of `npm test`: it needs Docker, a box image and minutes. Run:
 *   node --experimental-transform-types scripts/load-bench.ts --out <dir> [--agents 4] [--jobs 8]
 *     [--job-seconds 60] [--bytes 200000] [--seconds 240] [--image fakechris/lumenbox:0.3.14] [--snapshots]
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHeapSnapshot } from "node:v8";
import type Anthropic from "@anthropic-ai/sdk";

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1]! : fallback; };
const AGENTS = Number(arg("agents", "4")), JOBS = Number(arg("jobs", "8")), JOB_SECONDS = Number(arg("job-seconds", "60"));
const BYTES = Number(arg("bytes", "200000")), SECONDS = Number(arg("seconds", "240")), IMAGE = arg("image", "fakechris/lumenbox:0.3.14");
const OUT = arg("out", ""), SNAPSHOTS = process.argv.includes("--snapshots"), SAMPLE_MS = 2_000;
// Real agents carry long histories (35 MB on 2026-11-04); a fresh one carries none. Pre-fills each worker's transcript.
const SEED_MB = Number(arg("seed-transcript-mb", "0"));
if (OUT === "") throw new Error("--out <dir> is required (keep results out of the repository)");
mkdirSync(OUT, { recursive: true });

// The host's home is a throwaway directory, set before any module reads it.
const home = mkdtempSync(join(tmpdir(), "agentbox-load-bench-"));
process.env.AGENTBOX_HOME = home;
process.env.AGENTBOX_FOREGROUND_MS = "10000";

const { AgentRegistry } = await import("../src/agents/registry.ts");
const { BoxClient } = await import("../src/box/client.ts");
const { Orchestrator } = await import("../src/host/orchestrator.ts");
const { fakeModel } = await import("../src/host/testing/fake-model.ts");

// ── the box ─────────────────────────────────────────────────────────────────────────────────────────
const name = `lumenbox-load-bench-${process.pid}`;
const token = randomBytes(32).toString("hex");
execFileSync("docker", ["run", "--rm", "-d", "--name", name, "--shm-size=1g", "--memory", "4g", "-p", "127.0.0.1::1337", "-e", "BOXD_TOKEN", "--entrypoint", "/usr/local/bin/box-init", IMAGE, "sh", "-c", `timeout ${SECONDS + 600} /usr/local/bin/entrypoint.sh`], { env: { ...process.env, BOXD_TOKEN: token }, stdio: "ignore" });
const stopBox = () => spawnSync("docker", ["stop", name], { stdio: "ignore" });
process.on("exit", stopBox);
const address = execFileSync("docker", ["port", name, "1337/tcp"], { encoding: "utf8" }).trim().split("\n")[0]!;
const box = new BoxClient({ baseUrl: `http://${address}`, token });
for (let i = 0; ; i++) {
  try { await box.health(); break; } catch { if (i > 90) throw new Error("the bench box did not become healthy"); await new Promise(r => setTimeout(r, 1000)); }
}
const cgroup = () => {
  const out = spawnSync("docker", ["exec", name, "sh", "-c", "cat /sys/fs/cgroup/memory.current; grep -E '^(anon|file) ' /sys/fs/cgroup/memory.stat; grep '^usage_usec' /sys/fs/cgroup/cpu.stat; grep '^oom_kill' /sys/fs/cgroup/memory.events"], { encoding: "utf8" }).stdout.split("\n");
  const field = (key: string) => Number(out.find(line => line.startsWith(`${key} `))?.split(" ")[1] ?? 0);
  return { current: Number(out[0] ?? 0), anon: field("anon"), file: field("file"), cpuUsec: field("usage_usec"), oomKill: field("oom_kill") };
};

// ── the model: start JOBS printing commands, then acknowledge each ending ───────────────────────────
const message = (content: unknown[], stop: string) => ({ id: "m", type: "message", role: "assistant", model: "bench", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) as unknown as Anthropic.Message;
const say = (text: string) => message([{ type: "text", text, citations: [] }], "end_turn");
let ids = 0;
const shell = (command: string) => message([{ type: "tool_use", id: `b${ids++}`, name: "bash", input: { command, timeout_ms: (JOB_SECONDS + 120) * 1000 } }], "tool_use");
const printing = `for i in $(seq 1 ${JOB_SECONDS}); do head -c ${BYTES} /dev/urandom | base64 -w0; echo; sleep 1; done`;
function respond(params: Anthropic.MessageCreateParams): Anthropic.Message {
  // The probe is only ever asked "ping"; a worker never is.
  if (params.messages.some(entry => JSON.stringify(entry.content).includes("ping"))) return say("pong");
  const started = params.messages.flatMap(entry => (typeof entry.content === "string" ? [] : entry.content)).filter(block => block.type === "tool_use").length;
  const last = params.messages.at(-1);
  const answering = last !== undefined && typeof last.content !== "string" && last.content.some(block => block.type === "tool_result");
  // Numbered, so each is a distinct command: the host stops a turn that repeats one call four times.
  if (started < JOBS && (answering || started === 0)) return shell(`${printing} # job ${started + 1}`);
  return say("noted");
}
const client = fakeModel(({ params }) => respond(params), { create: () => say("summary") });

// ── the host ────────────────────────────────────────────────────────────────────────────────────────
const registry = new AgentRegistry(join(home, "agents"));
const workers = Array.from({ length: AGENTS }, (_, i) => registry.create({ name: `worker${i + 1}` }));
registry.create({ name: "probe" });
if (SEED_MB > 0) {
  for (const worker of workers) {
    const path = registry.transcriptPathFor(worker.id);
    mkdirSync(join(path, ".."), { recursive: true });
    const lines: string[] = [];
    for (let bytes = 0, i = 0; bytes < SEED_MB * 1048576; i++) {
      const line = JSON.stringify({ role: i % 2 === 0 ? "user" : "assistant", text: randomBytes(600).toString("base64"), at: new Date(Date.now() - 86_400_000 + i * 1000).toISOString() });
      lines.push(line); bytes += line.length + 1;
    }
    writeFileSync(path, lines.join("\n") + "\n");
  }
}
// How often whole transcripts are read and parsed, and from where: the count and bytes per sample, and the callers overall.
const reads = { count: 0, bytes: 0 }, readers = new Map<string, number>();
const readFile = (registry as unknown as { readTranscriptFile(path: string): unknown[] }).readTranscriptFile.bind(registry);
(registry as unknown as { readTranscriptFile(path: string): unknown[] }).readTranscriptFile = (path: string) => {
  reads.count++; reads.bytes += existsSync(path) ? statSync(path).size : 0;
  const caller = (new Error().stack ?? "").split("\n").slice(2).map(line => line.trim()).find(line => !/registry\.ts/.test(line))?.replace(/^at /, "").replace(/\(.*\/src\//, "(").slice(0, 90) ?? "?";
  readers.set(caller, (readers.get(caller) ?? 0) + 1);
  return readFile(path);
};
const orch = new Orchestrator({ registry, useBox: true, boxClient: box, inbox: null, client });
const connected = await orch.connectBox();
if (!connected.connected) throw new Error(`the host did not connect to the bench box: ${connected.detail}`);

const tsv = join(OUT, "samples.tsv");
writeFileSync(tsv, "t_s\theap_used_mb\theap_total_mb\trss_mb\texternal_mb\tarray_buffers_mb\twatched_jobs\tturns_in_flight\ttranscripts_mb\tbox_mb\tbox_anon_mb\tbox_file_mb\tbox_cpu_s\tbox_oom_kill\tprobe_latency_ms\ttranscript_reads\ttranscript_read_mb\n");
const mb = (bytes: number) => (bytes / 1048576).toFixed(1);
const transcriptBytes = (dir: string): number => {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? transcriptBytes(path) : entry.name.endsWith(".jsonl") ? statSync(path).size : 0;
  }
  return total;
};
let probeLatency = -1;
const t0 = Date.now();
const snapshot = (label: string) => { if (!SNAPSHOTS) return; const path = writeHeapSnapshot(join(OUT, `${label}.heapsnapshot`)); console.error(`[bench] snapshot ${label}: ${path}`); };

snapshot("start");
for (const worker of workers) void orch.prompt(worker.id, "Start the load.").catch(error => console.error(`[bench] ${worker.profile.name}: ${String(error)}`));
const probe = setInterval(() => { const at = Date.now(); void orch.prompt("probe", "ping").then(() => { probeLatency = Date.now() - at; }, () => {}); }, 5_000);
let peakHeap = 0, peakTaken = false;
while (Date.now() - t0 < SECONDS * 1000) {
  await new Promise(r => setTimeout(r, SAMPLE_MS));
  const memory = process.memoryUsage(), box = cgroup();
  const watched = workers.reduce((sum, worker) => sum + orch.jobWatch.countFor(worker.id), 0);
  appendFileSync(tsv, [((Date.now() - t0) / 1000).toFixed(0), mb(memory.heapUsed), mb(memory.heapTotal), mb(memory.rss), mb(memory.external), mb(memory.arrayBuffers), watched, orch.bus.activeCount(), mb(transcriptBytes(join(home, "agents"))), mb(box.current), mb(box.anon), mb(box.file), (box.cpuUsec / 1e6).toFixed(0), box.oomKill, probeLatency, reads.count, mb(reads.bytes)].join("\t") + "\n");
  reads.count = 0; reads.bytes = 0;
  if (memory.heapUsed > peakHeap) peakHeap = memory.heapUsed;
  // The peak is when every job is running: snapshot once there.
  if (!peakTaken && watched >= AGENTS * JOBS * 0.9) { snapshot("peak"); peakTaken = true; }
}
clearInterval(probe);
snapshot("end");

// ── what grew: heap snapshots summed by constructor ─────────────────────────────────────────────────
function byConstructor(path: string): Map<string, { count: number; bytes: number }> {
  const snap = JSON.parse(readFileSync(path, "utf8")) as { snapshot: { meta: { node_fields: string[]; node_types: [string[]] } }; nodes: number[]; strings: string[] };
  const fields = snap.snapshot.meta.node_fields, width = fields.length;
  const type = fields.indexOf("type"), nameAt = fields.indexOf("name"), size = fields.indexOf("self_size");
  const types = snap.snapshot.meta.node_types[0];
  const out = new Map<string, { count: number; bytes: number }>();
  for (let i = 0; i < snap.nodes.length; i += width) {
    const kind = types[snap.nodes[i + type]!]!;
    const key = kind === "object" || kind === "closure" ? snap.strings[snap.nodes[i + nameAt]!]! : `(${kind})`;
    const row = out.get(key) ?? { count: 0, bytes: 0 };
    row.count++; row.bytes += snap.nodes[i + size]!;
    out.set(key, row);
  }
  return out;
}
const report: string[] = [`# Load bench ${new Date().toISOString()}`, "", `agents ${AGENTS} × jobs ${JOBS}, each printing ${BYTES} random bytes (base64) a second for ${JOB_SECONDS} s; transcripts seeded to ${SEED_MB} MB; ran ${SECONDS} s on ${IMAGE}.`, `peak heapUsed ${mb(peakHeap)} MB. Samples: samples.tsv.`, ""];
if (SNAPSHOTS && existsSync(join(OUT, "start.heapsnapshot")) && existsSync(join(OUT, "peak.heapsnapshot"))) {
  const start = byConstructor(join(OUT, "start.heapsnapshot")), peak = byConstructor(join(OUT, "peak.heapsnapshot"));
  const grown = [...peak].map(([key, row]) => ({ key, count: row.count - (start.get(key)?.count ?? 0), bytes: row.bytes - (start.get(key)?.bytes ?? 0) })).sort((a, b) => b.bytes - a.bytes).slice(0, 15);
  report.push("## Grew between start and peak (self size, by constructor)", "", "| constructor | Δ count | Δ MB |", "|---|---:|---:|", ...grown.map(row => `| ${row.key.replace(/\|/g, "\\|").slice(0, 60)} | ${row.count} | ${mb(row.bytes)} |`), "");
}
// Since INV-1564 a read is a cache lookup; what costs is a parse. Absent before the cache existed.
const parses = (registry as unknown as { transcripts?: { counts: { full: number; appended: number; hits: number } } }).transcripts?.counts;
if (parses !== undefined) report.push("## Transcript parses (INV-1564 cache)", "", `full ${parses.full}, appended ${parses.appended}, hits ${parses.hits}`, "");
report.push("## Whole-transcript reads by caller", "", "| caller | reads |", "|---|---:|", ...[...readers].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([caller, n]) => `| ${caller.replace(/\|/g, "\\|")} | ${n} |`), "");
writeFileSync(join(OUT, "bench.md"), report.join("\n"));
console.error(`[bench] done: ${OUT}`);
stopBox();
if (process.argv.includes("--keep")) console.error(`[bench] kept the host home: ${home}`); else rmSync(home, { recursive: true, force: true });
process.exit(0);
