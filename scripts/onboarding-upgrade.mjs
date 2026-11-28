/**
 * The acceptance run's upgrade mode (INV-2209): the previous release installed and used, then the
 * candidate started on what it wrote.
 *
 * Every release note said "data from the previous version loads unchanged", and that was checked
 * by reading. `src/home-format.ts` numbers the home and `src/fixtures/home-0.4.9` holds one
 * release's home for a unit test, but nothing had started the real app on a real home a real
 * older app wrote, with its box and volumes. This does, on the published previous DMG and the
 * candidate: first use with the previous app (key, box, first reply), then the data an upgrade
 * must keep — a second agent, a conversation with a tool call, a memory, a routine, a task, a file
 * in each box volume — written through the app's own HTTP API with the run's session. The
 * previous app quits, the candidate starts on the same home, user-data and box, and reads it all
 * back. With `--downgrade-check` the previous app is started once more on the upgraded home and
 * must refuse it (exit 78, `electron/home-refused.cjs`) rather than open it.
 *
 * The pure parts — what the format record must say, what counts as read back, whether a refusal
 * is owed and what one looks like — are exported and tested; the walk takes the run's own App
 * and first-use steps as a kit, so there is one launcher and one isolation.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── pure parts (tested) ───────────────────────────────────────────────────────────────

/** -1, 0 or 1, comparing X.Y.Z numerically. */
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/**
 * Free space the run needs, in GB. A first pull is about 4 GB plus room (8). An upgrade run also
 * holds a second DMG and app (about 1 GB each, unpacked), and the copy of the home a rewriting
 * migration takes, and a candidate on a new version pulls a second image.
 */
export function requiredFreeGb(options) {
  if (options.upgradeFrom === undefined) return 8;
  return 8 + 3 + (options.upgradeFrom !== options.version ? 4 : 0);
}

/**
 * The highest home format an app reads, from its own `src/home-format.ts` (the registry is a list
 * of `{ to: n, … }`); undefined when the app has no such file — it predates format numbers
 * (INV-2201) and refuses nothing.
 */
export function knownFormat(source) {
  if (source === undefined) return undefined;
  const start = source.indexOf("HOME_MIGRATIONS");
  if (start < 0) return undefined;
  const list = source.slice(start, source.indexOf("];", start));
  const numbers = [...list.matchAll(/\{\s*to:\s*(\d+)/g)].map(match => Number(match[1]));
  return numbers.length === 0 ? undefined : Math.max(...numbers);
}

/**
 * What the home's format record says after the candidate opened it, against what it said before.
 * `before`/`after`: `{ format, ledger, backups }` — the number in `FORMAT` (undefined when absent),
 * the parsed `format-migrations.jsonl`, and the directories in `<home>-backups`. Returns what is
 * wrong (empty when nothing) and one line saying what happened.
 */
export function judgeFormat({ before, after, candidateFormat, candidateVersion, backupExists = () => true }) {
  const problems = [];
  if (candidateFormat !== undefined && after.format !== candidateFormat) problems.push(`FORMAT is ${after.format ?? "absent"}, the candidate writes ${candidateFormat}`);
  const kept = before.ledger.every((entry, i) => JSON.stringify(after.ledger[i]) === JSON.stringify(entry));
  if (!kept || after.ledger.length < before.ledger.length) problems.push("format-migrations.jsonl lost or changed lines the previous app wrote; it is append-only");
  const added = after.ledger.slice(before.ledger.length);
  const from = before.format ?? 0;
  const expected = Math.max(0, (after.format ?? 0) - from);
  if (added.length !== expected) problems.push(`format-migrations.jsonl gained ${added.length} line(s) for ${from} → ${after.format ?? "absent"}, expected ${expected}`);
  added.forEach((entry, i) => {
    if (entry.format !== from + i + 1 || entry.from !== from + i) problems.push(`ledger line ${before.ledger.length + i + 1} says ${entry.from} → ${entry.format}, expected ${from + i} → ${from + i + 1}`);
    if (entry.appVersion !== candidateVersion) problems.push(`ledger line for format ${entry.format} was written by ${entry.appVersion}, not the candidate ${candidateVersion}`);
    if (entry.backup !== undefined && !backupExists(entry.backup)) problems.push(`format ${entry.format} says it backed the home up to ${entry.backup}, which does not exist`);
  });
  const backedUp = added.filter(entry => entry.backup !== undefined);
  const newBackups = after.backups.filter(name => !before.backups.includes(name));
  if (backedUp.length === 0 && newBackups.length > 0) problems.push(`a backup appeared (${newBackups.join(", ")}) though no migration recorded one`);
  const steps = added.map(entry => `${entry.from}→${entry.format} "${entry.name}"${entry.backup !== undefined ? ` (backup ${entry.backup})` : " (stamp only: no backup)"}`);
  const detail = added.length === 0
    ? `format ${after.format ?? "absent"} before and after: no migration owed, no backup`
    : `FORMAT ${before.format ?? "absent"} → ${after.format}; ${steps.join("; ")}${backedUp.length === 0 ? "; no migration had work here (needed), so no copy was taken" : ""}`;
  return { problems, detail };
}

/**
 * Which of the things written before the upgrade the candidate does not show. `seed` is what was
 * written (and what the previous app showed of it); `seen` is the same reads made on the candidate.
 */
export function readBackProblems(seed, seen) {
  const missing = [];
  if (!seen.agents.some(agent => agent.id === seed.agent.id && agent.name === seed.agent.name)) missing.push(`agent ${seed.agent.name}`);
  for (const text of seed.said) if (!seen.userTexts.some(shown => shown.includes(text))) missing.push(`the message "${text.slice(0, 40)}…"`);
  if (seen.replies < seed.replies) missing.push(`replies: ${seen.replies} of the ${seed.replies} there were`);
  if (!seen.memory.some(line => line.includes(seed.word))) missing.push(`the memory holding ${seed.word}`);
  const routine = seen.routines.find(entry => entry.slug === seed.routine.slug);
  if (routine === undefined) missing.push(`routine ${seed.routine.slug}`);
  else if (seed.routine.schedule !== undefined && routine.schedule !== seed.routine.schedule) missing.push(`routine ${seed.routine.slug}'s schedule (${routine.schedule} ≠ ${seed.routine.schedule})`);
  if (!seen.tasks.some(task => task.id === seed.task.id && task.title === seed.task.title)) missing.push(`task "${seed.task.title}"`);
  if (seen.key !== true) missing.push("the saved key (/api/setup no longer counts it)");
  if (seed.provider !== undefined && seen.provider !== seed.provider) missing.push(`the provider (${seen.provider} ≠ ${seed.provider})`);
  return missing;
}

/** Whether the previous app owes a refusal of the upgraded home, and why. */
export function downgradeExpectation(previousFormat, candidateFormat, previousVersion) {
  if (previousFormat === undefined) return { refuse: false, why: `LumenBox ${previousVersion} predates the home format number (INV-2201): it has no refusal to show, so there is nothing to check` };
  if (candidateFormat === undefined || candidateFormat <= previousFormat) return { refuse: false, why: `the candidate writes format ${candidateFormat ?? "unknown"} and LumenBox ${previousVersion} reads up to ${previousFormat}: nothing to refuse` };
  return { refuse: true, why: `the candidate wrote format ${candidateFormat}; LumenBox ${previousVersion} reads up to ${previousFormat}` };
}

/**
 * A refusal as the server makes it: exit 78 (HOME_REFUSED_EXIT), an `error: …` line saying a newer
 * LumenBox wrote the home, with the format found, and the home's record untouched.
 */
export function judgeRefusal({ code, output, format, before, after }) {
  const problems = [];
  const said = output.split("\n").reverse().find(line => line.startsWith("error: "));
  if (code !== 78) problems.push(`exit status ${code ?? "none (still running or killed)"}, not 78`);
  if (said === undefined) problems.push("no `error: …` line in its output");
  else if (!/newer LumenBox wrote this home/.test(said) || !said.includes(`format ${format}`)) problems.push(`its message does not say a newer version wrote format ${format}: ${said.slice(0, 200)}`);
  if (before.format !== after.format || JSON.stringify(before.ledger) !== JSON.stringify(after.ledger)) problems.push("the home's FORMAT or format-migrations.jsonl changed");
  return { problems, message: said?.slice("error: ".length) };
}

/**
 * Whether the server answering is the candidate. An upgrade starts the candidate on the port the
 * previous app used; if the previous server outlived its app, every later check would read the old
 * app and pass. `build` is `/api/state`'s `{ version, commit }`; `stamped` the candidate's packaged
 * package.json (`version`, and `buildCommit` when the build stamped one — either may be the short form).
 */
export function servingProblems(build, stamped) {
  const problems = [];
  if (build?.version !== stamped.version) problems.push(`the server says version ${build?.version ?? "nothing"}, the candidate is ${stamped.version}`);
  if (stamped.buildCommit !== undefined) {
    const commit = String(build?.commit ?? "");
    const same = commit.length >= 7 && (commit.startsWith(stamped.buildCommit) || stamped.buildCommit.startsWith(commit));
    if (!same) problems.push(`the server says build ${commit || "nothing"}, the candidate is ${stamped.buildCommit}`);
  }
  return problems;
}

// ── machine parts ─────────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The home's format record as it is on disk now. */
export function homeSnapshot(home) {
  let format;
  try { format = Number(readFileSync(join(home, "FORMAT"), "utf8").trim()); } catch {}
  const ledger = [];
  try {
    for (const line of readFileSync(join(home, "format-migrations.jsonl"), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try { ledger.push(JSON.parse(line)); } catch {}
    }
  } catch {}
  let backups = [];
  try { backups = readdirSync(`${home}-backups`); } catch {}
  return { format, ledger, backups };
}

/** What an installed app's build stamped into its package.json. */
function appStamp(appRoot) {
  return JSON.parse(readFileSync(join(appRoot, "LumenBox.app", "Contents", "Resources", "app", "package.json"), "utf8"));
}

/** The format an installed app reads, from the source it ships. */
export function appFormat(appRoot) {
  const file = join(appRoot, "LumenBox.app", "Contents", "Resources", "app", "src", "home-format.ts");
  return knownFormat(existsSync(file) ? readFileSync(file, "utf8") : undefined);
}

function asList(entries) {
  return Array.isArray(entries) ? entries : entries?.entries ?? [];
}

/** Sends a message to an agent through the API and waits for the turn to end; returns the transcript after it. */
async function converse(app, agentId, text, timeoutMs) {
  const transcript = async () => asList(await app.api(`/api/transcript?all=1&agent=${encodeURIComponent(agentId)}&conversation=main`));
  const before = (await transcript()).length;
  await app.api("/api/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: agentId, conversation: "main", text }) });
  return app.waitFor(`a reply to "${text.slice(0, 30)}…"`, async () => {
    const state = await app.api("/api/state");
    if (state.agents?.find(agent => agent.id === agentId)?.running) return undefined;
    const entries = await transcript();
    const after = entries.slice(before);
    const asked = after.findIndex(entry => entry.kind === "text" && entry.role === "user" && entry.text.includes(text.slice(0, 40)));
    const answer = asked < 0 ? undefined : after.slice(asked + 1).filter(entry => entry.kind === "text" && entry.role === "assistant" && entry.text.trim() !== "").pop();
    return answer === undefined ? undefined : { entries, answer: answer.text, tools: after.filter(entry => entry.kind === "tools").flatMap(entry => entry.tools.map(tool => tool.name ?? tool.tool ?? "?")) };
  }, timeoutMs, 3000);
}

/** What the app shows of the seeded data, read the same way before and after. */
async function readSeen(app, agentId) {
  const state = await app.api("/api/state");
  const entries = asList(await app.api(`/api/transcript?all=1&agent=${encodeURIComponent(agentId)}&conversation=main`));
  const memory = await app.api(`/api/memory/agent?agent=${encodeURIComponent(agentId)}`);
  const schedules = await app.api("/api/schedules");
  const tasks = await app.api("/api/tasks");
  const setup = await app.api("/api/setup");
  const config = await app.api("/api/config");
  return {
    agents: (state.agents ?? []).map(agent => ({ id: agent.id, name: agent.name })),
    userTexts: entries.filter(entry => entry.kind === "text" && entry.role === "user").map(entry => entry.text),
    replies: entries.filter(entry => entry.kind === "text" && entry.role === "assistant").length,
    memory: [...(memory.own ?? []), ...(memory.shared ?? [])].map(line => String(line.text ?? "")),
    routines: (schedules.schedules ?? []).map(entry => ({ slug: entry.slug, schedule: entry.schedule })),
    tasks: (tasks.tasks ?? []).map(task => ({ id: task.id, title: task.title })),
    key: setup.key,
    provider: typeof config.current === "string" ? config.current : undefined,
  };
}

const PROBE_FILES = { work: "/home/box/work/lumenbox-upgrade-probe.txt", config: "/home/box/.config/box-chrome-0/lumenbox-upgrade-probe" };

/** The run's own box only: `docker exec` into the container this run made, as the box's user. */
function inBox(kit, script) {
  return kit.sh("docker", ["exec", "--user", "box", kit.run.container, "sh", "-c", script]);
}

function volumesNow(kit) {
  return kit.run.manifest.box.volumes.map(name => {
    try { return { name, createdAt: JSON.parse(kit.sh("docker", ["volume", "inspect", name]))[0].CreatedAt }; } catch { return { name, createdAt: undefined }; }
  });
}

function containerId(kit) {
  try { return kit.sh("docker", ["inspect", "--format", "{{.Id}}", kit.run.container]).slice(0, 12); } catch { return undefined; }
}

/**
 * The previous app's server started by itself on the upgraded home, the way the shell starts it
 * (ELECTRON_RUN_AS_NODE, `web --desktop`), to read its exit status: the shell turns 78 into the
 * dialog and quits, and a shell's own status says nothing about its child's.
 */
function serverExit(kit, appRoot, home, timeoutMs) {
  const resources = join(appRoot, "LumenBox.app", "Contents", "Resources", "app");
  const binary = join(appRoot, "LumenBox.app", "Contents", "MacOS", "LumenBox");
  const logs = join(kit.run.dir, "downgrade", "server-logs");
  const env = kit.appEnv(process.env, { home, logs, container: kit.run.container }, { ELECTRON_RUN_AS_NODE: "1" });
  kit.run.recordLogs(logs);
  return new Promise(done => {
    const child = spawn(binary, ["--experimental-transform-types", join(resources, "src", "cli.ts"), "web", "--port", String(kit.run.options.port), "--desktop"], { cwd: resources, env, stdio: ["ignore", "pipe", "pipe"] });
    kit.run.recordProcess(child.pid);
    const out = [];
    child.stdout.on("data", chunk => out.push(chunk));
    child.stderr.on("data", chunk => out.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", code => { clearTimeout(timer); done({ code, output: Buffer.concat(out).toString("utf8") }); });
  });
}

/** A picture of the windows a process has on screen (the refusal dialog is one), when macOS lets this shell take it. */
function windowShot(kit, pid, file) {
  const script = `ObjC.import("CoreGraphics"); ObjC.import("Foundation");
    var list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0)); var ids = [];
    for (var i = 0; i < list.count; i++) { var w = list.objectAtIndex(i); if (w.objectForKey("kCGWindowOwnerPID").intValue === ${Number(pid)}) ids.push(w.objectForKey("kCGWindowNumber").intValue); }
    ids.join(",")`;
  let ids = "";
  try { ids = kit.sh("osascript", ["-l", "JavaScript", "-e", script]); } catch (error) { return `no window list (${error.message.split("\n")[0]})`; }
  const first = ids.split(",").filter(Boolean)[0];
  if (first === undefined) return "no window of the app on screen";
  try {
    kit.sh("screencapture", ["-x", "-o", `-l${first}`, file]);
    return existsSync(file) ? `window ${first} captured to ${file}` : `screencapture wrote nothing for window ${first}`;
  } catch (error) {
    return `screencapture refused (${error.message.split("\n")[0]})`;
  }
}

/**
 * The walk. `kit`: { run, App, firstUse, sh, appEnv }. The previous app was installed into
 * `<run>/previous`, the candidate into `<run>`; both use `<run>/upgrade/home` and
 * `<run>/upgrade/user-data`, as one person's machine does across an upgrade.
 */
export async function phaseUpgrade(kit) {
  const { run } = kit;
  const { options } = run;
  const shared = { home: join(run.dir, "upgrade", "home"), userData: join(run.dir, "upgrade", "user-data") };
  const previousRoot = join(run.dir, "previous");
  const word = `ZEPHYR${run.container.slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
  const replyMs = options.replyTimeoutMin * 60_000;
  const seed = { word, said: [] };
  let seeded = false;

  const previous = new kit.App(run, "previous", {}, { appRoot: previousRoot, ...shared });
  try {
    previous.start();
    if (!(await kit.firstUse(run, previous, "previous"))) return;
    seeded = (await run.step("previous: a second agent", async () => {
      const name = `Probe ${word.slice(-4)}`;
      const made = await previous.api("/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description: "Made by the upgrade acceptance run (INV-2209)." }) });
      seed.agent = { id: made.id ?? made.agent?.id, name: made.name ?? made.agent?.name ?? name };
      if (!seed.agent.id) throw new Error(`POST /api/agents answered without an id: ${JSON.stringify(made).slice(0, 160)}`);
      return `${seed.agent.name} (${seed.agent.id})`;
    }))
      && (await run.step("previous: a conversation of three turns, one with a tool call", async () => {
        const turns = [
          `Please use your RememberFact tool now to remember this fact: the upgrade code word is ${word}. Then confirm in one short sentence.`,
          "What is the upgrade code word? Answer with the word only.",
          "Thank you. Reply with the single word: noted.",
        ];
        const tools = [];
        let last;
        for (const text of turns) {
          last = await converse(previous, seed.agent.id, text, replyMs);
          seed.said.push(text);
          tools.push(...last.tools);
        }
        seed.replies = last.entries.filter(entry => entry.kind === "text" && entry.role === "assistant").length;
        await previous.shot("07-conversation").catch(() => {});
        return `${turns.length} turns, ${seed.replies} replies; tools called: ${tools.join(", ") || "none"}; last reply: ${last.answer.replace(/\s+/g, " ").slice(0, 80)}`;
      }))
      && (await run.step("previous: a memory", async () => {
        const lines = await previous.waitFor(`a memory holding ${word}`, async () => {
          const got = await previous.api(`/api/memory/agent?agent=${encodeURIComponent(seed.agent.id)}`);
          const all = [...(got.own ?? []), ...(got.shared ?? [])].map(line => String(line.text ?? ""));
          return all.some(line => line.includes(word)) ? all : undefined;
        }, 60_000, 2000);
        return `${lines.length} line(s); one holds ${word}`;
      }))
      && (await run.step("previous: a routine (a skill with schedule:)", async () => {
        const made = await previous.api("/api/automations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Upgrade probe ${word}`, body: `Say the upgrade code word ${word}.`, triggerType: "schedule", schedule: "0 9 * * 1" }) }); // run by the box's default runner: naming an agent is refused unless it is one the runner rules allow
        const listed = await previous.waitFor("the routine in /api/schedules", async () => (await previous.api("/api/schedules")).schedules?.find(entry => entry.slug === made.slug), 30_000);
        seed.routine = { slug: made.slug, schedule: listed.schedule };
        return `${made.slug}, schedule ${listed.schedule ?? "?"}, written paused`;
      }))
      && (await run.step("previous: a task", async () => {
        const made = await previous.api("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `Upgrade probe task ${word}`, description: "Kept across the upgrade (INV-2209)." }) });
        seed.task = { id: made.task.id, title: made.task.title };
        return `${seed.task.id} "${seed.task.title}"`;
      }))
      && (await run.step("previous: a file in each box volume", async () => {
        // The work volume holds what agents made; the config volume holds the browser profiles (box-chrome-N).
        inBox(kit, `printf %s ${word} > ${PROBE_FILES.work} && mkdir -p $(dirname ${PROBE_FILES.config}) && printf %s ${word} > ${PROBE_FILES.config}`);
        seed.volumes = volumesNow(kit);
        seed.container = containerId(kit);
        return `${PROBE_FILES.work} and ${PROBE_FILES.config} hold ${word}; container ${seed.container}`;
      }))
      && (await run.step("previous: what it shows, read through the API", async () => {
        const seen = await readSeen(previous, seed.agent.id);
        seed.provider = seen.provider;
        const missing = readBackProblems(seed, seen);
        if (missing.length > 0) throw new Error(`the previous app itself does not show: ${missing.join("; ")}`);
        return `agents ${seen.agents.length}, messages ${seen.userTexts.length}, replies ${seen.replies}, memory lines ${seen.memory.length}, routines ${seen.routines.length}, tasks ${seen.tasks.length}; provider ${seen.provider ?? "?"}`;
      }));
  } finally {
    await previous.stop();
  }
  if (!seeded) return;
  const before = homeSnapshot(shared.home);
  run.note("previous: the home it left", `FORMAT ${before.format ?? "absent"}; ${before.ledger.length} ledger line(s): ${before.ledger.map(entry => `${entry.format} by ${entry.appVersion}`).join(", ") || "none"}`);

  const candidateFormat = appFormat(run.dir);
  const candidate = new kit.App(run, "candidate", {}, { appRoot: run.dir, ...shared });
  try {
    candidate.start();
    if (!(await run.step("upgrade: the candidate opens the previous home", async () => {
      const asked = await candidate.firstRun();
      await candidate.waitFor("the server", async () => (await candidate.api("/api/setup")) !== undefined, 180_000);
      await candidate.connect();
      await candidate.shot("01-opened");
      return `server answers, window open; first-run question: ${asked}`;
    }))) return;
    if (!(await run.step("upgrade: the server answering is the candidate's build", async () => {
      const stamped = appStamp(run.dir);
      const { build } = await candidate.api("/api/state");
      const problems = servingProblems(build, stamped);
      if (problems.length > 0) throw new Error(`${problems.join("; ")}: the previous app's server may still hold port ${options.port}, and nothing after this would test the candidate`);
      return `version ${build.version}, build ${build.commit}`;
    }))) return;
    await run.step("upgrade: FORMAT and format-migrations.jsonl say what the migrations did", async () => {
      const after = homeSnapshot(shared.home);
      const verdict = judgeFormat({ before, after, candidateFormat, candidateVersion: options.version, backupExists: path => existsSync(path) });
      if (verdict.problems.length > 0) throw new Error(`${verdict.problems.join("; ")} (${verdict.detail})`);
      return verdict.detail;
    });
    await run.step("upgrade: everything written before reads back", async () => {
      const seen = await readSeen(candidate, seed.agent.id);
      const missing = readBackProblems(seed, seen);
      if (missing.length > 0) throw new Error(`missing after the upgrade: ${missing.join("; ")}`);
      return `agent ${seed.agent.name}; ${seed.said.length} messages and ${seen.replies} replies; the memory of ${word}; routine ${seed.routine.slug} (${seed.routine.schedule}); task ${seed.task.id}; key counted; provider ${seen.provider ?? "?"}`;
    });
    await run.step("upgrade: the box comes up with its volumes kept", async () => {
      let up = await candidate.waitFor("the box", async () => (await candidate.api("/api/state")).box?.ok === true, 120_000, 3000).catch(() => false);
      let pressed = "";
      if (!up) {
        // Not reconnected by itself: a person presses Start the box, as on the first run.
        await candidate.inPage("openChat(Object.keys(next.agents)[0] || ''), true");
        await candidate.waitFor("the Start button", () => candidate.inPage("!!document.getElementById('box-start')"), 30_000);
        await candidate.inPage("document.getElementById('box-start').click(), true");
        up = await candidate.waitFor("the box to connect", async () => (await candidate.api("/api/state")).box?.ok === true, options.boxTimeoutMin * 60_000, 5000);
        pressed = "Start the box pressed; ";
      }
      const volumes = volumesNow(kit);
      const changed = volumes.filter((volume, i) => volume.createdAt === undefined || volume.createdAt !== seed.volumes[i]?.createdAt).map(volume => volume.name);
      if (changed.length > 0) throw new Error(`volumes replaced or missing: ${changed.join(", ")}`);
      const files = Object.values(PROBE_FILES).map(path => [path, inBox(kit, `cat ${path} 2>/dev/null || true`)]);
      const lost = files.filter(([, text]) => text !== word).map(([path]) => path);
      if (lost.length > 0) throw new Error(`files lost from the volumes: ${lost.join(", ")}`);
      const id = containerId(kit);
      await candidate.shot("02-box-up");
      return `${pressed}box up; volumes ${volumes.map(volume => volume.name).join(", ")} the same (created ${seed.volumes[0]?.createdAt ?? "?"}); both probe files hold ${word}; container ${id === seed.container ? `${id}, the same one` : `${seed.container} → ${id}, recreated`}`;
    });
    await run.step("upgrade: a new message is answered", async () => {
      const got = await converse(candidate, seed.agent.id, "After the upgrade: what is the upgrade code word? Answer with the word only.", replyMs);
      await candidate.shot("03-new-reply");
      return `reply: ${got.answer.replace(/\s+/g, " ").slice(0, 120)}${got.answer.includes(word) ? ` (names ${word})` : ` (does not name ${word})`}`;
    });
  } finally {
    await candidate.stop();
  }

  if (!options.downgradeCheck) return;
  const expectation = downgradeExpectation(appFormat(previousRoot), candidateFormat, options.upgradeFrom);
  if (!expectation.refuse) {
    run.note("downgrade: the previous app on the upgraded home", expectation.why);
    return;
  }
  const upgraded = homeSnapshot(shared.home);
  await run.step("downgrade: the previous app does not open the upgraded home", async () => {
    const older = new kit.App(run, "downgrade", {}, { appRoot: previousRoot, ...shared });
    try {
      older.start();
      void older.firstRun().catch(() => {}); // answered if the shell asks again; a refused home usually opens no page at all
      const said = await older.waitFor("the shell to report the refusal", async () => {
        const line = older.output().split("\n").find(entry => entry.includes("server refused the home:"));
        return line;
      }, 120_000, 1000);
      await sleep(1500); // the dialog is drawn after the line is logged
      const shot = windowShot(kit, older.child.pid, join(run.dir, "shots", "downgrade-01-refusal-dialog.png"));
      const served = await older.api("/api/setup").then(() => true, () => false);
      if (served) throw new Error("its server answers: it opened the upgraded home");
      return `${expectation.why}. The shell logged: ${said.replace(/^.*server refused the home: /, "").slice(0, 200)}. Server never answered. Dialog picture: ${shot}`;
    } finally {
      await older.stop();
    }
  });
  await run.step("downgrade: the previous server exits 78 with its message, home unchanged", async () => {
    const got = await serverExit(kit, previousRoot, shared.home, 120_000);
    const verdict = judgeRefusal({ code: got.code, output: got.output, format: candidateFormat, before: upgraded, after: homeSnapshot(shared.home) });
    if (verdict.problems.length > 0) throw new Error(verdict.problems.join("; "));
    return `exit 78; "${verdict.message.slice(0, 220)}"; FORMAT and ledger unchanged`;
  });
}
