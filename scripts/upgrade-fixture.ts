/**
 * Writes the home an upgrade test starts from (docs/05 §2.0, docs/106 §6, INV-2201).
 *
 * The fixture under `src/fixtures/home-<version>/` is what that release wrote, kept as files:
 * the current code cannot produce it, because the point is that the current code did not. So
 * this is run once per stable line, **from a checkout of the release being frozen**, with the
 * real writers — a scripted episode on the real stack (scenario.ts) for the agents, their
 * conversation and their memory; the task board, the plan and `saveConfig` for the rest:
 *
 *   git worktree add /tmp/lumenbox-0.4.9 v0.4.9
 *   cp scripts/upgrade-fixture.ts /tmp/lumenbox-0.4.9/scripts/ && cd /tmp/lumenbox-0.4.9
 *   AGENTBOX_TEST=1 AGENTBOX_HOME="$(mktemp -d)/home" \
 *     node --experimental-transform-types scripts/upgrade-fixture.ts <repo>/src/fixtures/home-0.4.9
 *
 * It refuses any home that is not a fresh directory under the system's temporary directory: it
 * writes through the same code a live installation does, and must never be pointed at one.
 * Left out of the copy: the box and page tokens and each agent's desktop claim (credentials are
 * re-minted when absent, and none belongs in a repository), locks, and the derived transcript index.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { AgentRegistry } from "../src/agents/registry.ts";
import { ensureConfigFile, saveConfig } from "../src/config.ts";
import { runEpisode } from "../src/host/scenario.ts";
import { TaskStore } from "../src/host/tasks.ts";

const out = process.argv[2];
const home = process.env.AGENTBOX_HOME;
if (out === undefined || home === undefined || home === "") {
  console.error("usage: AGENTBOX_HOME=<a fresh temp dir> node --experimental-transform-types scripts/upgrade-fixture.ts <out-dir>");
  process.exit(2);
}
mkdirSync(home, { recursive: true });
if (!realpathSync(home).startsWith(realpathSync(tmpdir())) || readdirSync(home).length > 0) {
  console.error(`AGENTBOX_HOME must be a fresh, empty directory under ${tmpdir()}; ${home} is not. This writes through the real writers and is never pointed at an installation.`);
  process.exit(2);
}

// From the first release with a format number on, a home is stamped when it is made (docs/05 §2.0); 0.4.9 has no such module and writes none.
const format = await import("../src/home-format.ts").catch(() => undefined);
format?.openHome({ home, appVersion: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version });

const FACT = "The quarterly report goes out on the 3rd of each month.";
const replies = [
  { call: "RememberFact", input: { fact: FACT } },
  { say: "Noted: the quarterly report goes out on the 3rd of each month." },
  { say: "That the quarterly report goes out on the 3rd of each month." },
] as const;
let step = 0;
const episode = await runEpisode({
  team: [
    { name: "Nova", description: "Keeps the team's notes and answers from them." },
    { name: "Vera", description: "Reviews what Nova writes." },
  ],
  says: ["Remember that the quarterly report goes out on the 3rd of each month.", "What did I ask you to remember?"],
  script: () => replies[step++] ?? { say: "(nothing more)" },
});

// The episode's registry lives in a directory of its own; in an installation that directory is <home>/agents.
cpSync(episode.registry.root, join(home, "agents"), { recursive: true });
episode.cleanup();

const registry = new AgentRegistry(join(home, "agents"));
const nova = registry.resolve("Nova");
registry.writePlan(nova.id, "1. Keep the reporting calendar current.\n2. Tell Vera when a date moves.\n");
new TaskStore().create({ title: "Send the quarterly report", description: "Due on the 3rd.", requester: "person", assigneeId: nova.id });
ensureConfigFile();
saveConfig({ provider: "anthropic", model: "claude-opus-5", channelAllow: ["feishu:ou_fixture_person"], startupItem: false });

const LEFT_OUT = (name: string) => name === "token" || name === "ui-token" || name === "box-owner" || name.endsWith(".lock") || name.startsWith("transcript-index");
rmSync(resolve(out), { recursive: true, force: true });
cpSync(home, resolve(out), { recursive: true, filter: source => !LEFT_OUT(basename(source)) });
console.log(`wrote ${resolve(out)} from ${home}${existsSync(join(home, "FORMAT")) ? "" : " (no FORMAT file: a home from before the format number)"}`);
