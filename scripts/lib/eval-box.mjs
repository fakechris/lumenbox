/**
 * The eval scripts' own box (INV-1370): created for a run, removed when the run ends — on
 * success, on failure and on Ctrl-C — so a machine is clean after an eval without a person
 * remembering what to delete. Two days of INV-1340/1359 rebuilt `lumenbox-eval-box` by hand
 * four times and left a dev image behind; that is the bookkeeping this file owns.
 *
 * What it removes is narrow by construction: only names it created, only names under
 * `lumenbox-eval-`, and it prints the list first. `--box use <name>` (or AGENTBOX_CONTAINER)
 * attaches to an existing box and removes nothing; `--box keep` creates one and leaves it.
 *
 *   --box create            default when AGENTBOX_CONTAINER is unset: a fresh lumenbox-eval-<run>
 *   --box keep              the same, but left running at the end (its name is printed)
 *   --box use <name>        an existing box; nothing is removed (what AGENTBOX_CONTAINER means)
 *   --image build           build the current Dockerfile as lumenbox-eval:<version> first (engines
 *                           pinned at the presets' versions), removed with the box unless kept
 */
import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

export const EVAL_PREFIX = "lumenbox-eval-";
export const EVAL_IMAGE_REPO = "lumenbox-eval";

/** A box name this module may create and remove. */
export function evalBoxName(runId) {
  const id = String(runId).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (id === "") throw new Error("An eval box needs a run id.");
  return `${EVAL_PREFIX}${id}`;
}

/** Refuses any name outside the prefix: the one guard between this code and someone's real box. */
export function assertDisposable(name) {
  if (typeof name !== "string" || !name.startsWith(EVAL_PREFIX) || name.length <= EVAL_PREFIX.length) {
    throw new Error(`Refusing to remove "${name}": only boxes named ${EVAL_PREFIX}* that this run created are removed.`);
  }
}

/** Everything a created box leaves on the machine, named the way BoxManager names it. */
export function teardownList(name, extras = {}) {
  assertDisposable(name);
  return {
    container: name,
    volumes: [`${name}-work`, `${name}-config`, `${name}-hostd`],
    network: `${name}-net`,
    ...(extras.tokenPath !== undefined ? { tokenPath: extras.tokenPath } : {}),
    images: [...(extras.images ?? [])].filter(ref => ref.startsWith(`${EVAL_IMAGE_REPO}:`)),
  };
}

/** The list printed before anything is removed. */
export function renderTeardown(list) {
  return [
    `Removing what this run created (${list.container}):`,
    `  container  ${list.container}`,
    ...list.volumes.map(volume => `  volume     ${volume} (if present)`),
    `  network    ${list.network} (if present)`,
    ...(list.tokenPath !== undefined ? [`  token      ${list.tokenPath}`] : []),
    ...list.images.map(image => `  image      ${image}`),
  ].join("\n");
}

/** Which mode the flags and environment ask for. AGENTBOX_CONTAINER keeps meaning "use this box". */
export function boxMode(argv, env = process.env) {
  const at = argv.indexOf("--box");
  const value = at < 0 ? undefined : argv[at + 1];
  if (value === "use") {
    const name = argv[at + 2] ?? env.AGENTBOX_CONTAINER;
    if (name === undefined || name.startsWith("--")) throw new Error("--box use needs a box name.");
    return { mode: "use", name };
  }
  if (value === "create" || value === "keep") return { mode: value };
  if (value !== undefined) throw new Error(`--box ${value}: expected create, keep or use <name>.`);
  if (env.AGENTBOX_CONTAINER !== undefined) return { mode: "use", name: env.AGENTBOX_CONTAINER };
  return { mode: "create" };
}

const docker = args => spawnSync("docker", args, { encoding: "utf8" });
const imagesOf = repo => (docker(["images", repo, "--format", "{{.Repository}}:{{.Tag}}"]).stdout ?? "").split("\n").filter(line => line !== "" && !line.endsWith(":<none>"));

/**
 * Opens the box the flags ask for and returns its name and a `close()` that removes what this
 * run created (nothing, for `use` and `keep`). Sets AGENTBOX_CONTAINER and AGENTBOX_TOKEN for the
 * rest of the script. Installs SIGINT/SIGTERM handlers so an interrupted run cleans up too.
 */
export async function openEvalBox({ argv = process.argv, runId = `${Date.now().toString(36)}`, log = console.log } = {}) {
  const chosen = boxMode(argv);
  const { loadBoxToken, boxTokenPath, BoxManager, defaultBoxConfig } = await import("../../src/box/docker.ts");
  if (chosen.mode === "use") {
    process.env.AGENTBOX_CONTAINER = chosen.name;
    process.env.AGENTBOX_TOKEN ??= loadBoxToken(chosen.name);
    return { name: chosen.name, created: false, close: async () => {} };
  }

  const name = evalBoxName(runId);
  const images = [];
  let image = process.env.AGENTBOX_IMAGE;
  if (argv.includes("--image") && argv[argv.indexOf("--image") + 1] === "build") {
    const before = new Set(imagesOf(EVAL_IMAGE_REPO));
    const { PRESETS } = await import("../../src/host/presets.ts");
    const pins = Object.fromEntries(PRESETS.map(preset => [`${{ opencode: "OPENCODE", claude: "CLAUDE_CODE", pi: "PI", mcode: "MCODE" }[preset.name]}_VERSION`, preset.install.version]));
    log(`building ${EVAL_IMAGE_REPO} from the current Dockerfile (${Object.entries(pins).map(([k, v]) => `${k}=${v}`).join(" ")})…`);
    execFileSync("npm", ["run", "-s", "build:image"], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, ...pins, AGENTBOX_IMAGE_REPO: EVAL_IMAGE_REPO } });
    const { packageVersion } = await import("../../src/box/docker.ts");
    image = `${EVAL_IMAGE_REPO}:${packageVersion()}`;
    images.push(...imagesOf(EVAL_IMAGE_REPO).filter(ref => !before.has(ref)));
  }

  process.env.AGENTBOX_CONTAINER = name;
  const token = loadBoxToken(name);
  process.env.AGENTBOX_TOKEN = token;
  const tokenPath = boxTokenPath(name);
  const manager = new BoxManager(defaultBoxConfig({ containerName: name, token, ...(image !== undefined ? { image } : {}) }));
  log(`creating ${name}${image !== undefined ? ` on ${image}` : ""}…`);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (chosen.mode === "keep") {
      log(`\nkept ${name}${images.length > 0 ? ` and ${images.join(", ")}` : ""}; remove it yourself when done.`);
      return;
    }
    const list = teardownList(name, { tokenPath, images });
    log(`\n${renderTeardown(list)}`);
    await manager.down({ remove: true }).catch(error => log(`  container: ${error instanceof Error ? error.message : String(error)}`));
    for (const volume of list.volumes) docker(["volume", "rm", volume]);
    rmSync(list.tokenPath, { force: true });
    for (const ref of list.images) docker(["image", "rm", ref]);
    const left = docker(["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"]).stdout.trim();
    log(left === "" ? "  done: nothing of this run is left." : `  still present: ${left}`);
  };
  const onSignal = signal => {
    log(`\n${signal}: cleaning up before exit…`);
    void close().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await manager.up({ onOutput: line => { if (/error|fail/i.test(line)) log(`  ${line}`); } });
  } catch (error) {
    await close();
    throw error;
  }
  return { name, created: true, close };
}
