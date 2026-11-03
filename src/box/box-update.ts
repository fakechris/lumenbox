/**
 * Updating a box to the image this app expects, in one place (INV-1538, docs/12).
 *
 * A box's data is not in its container: what agents made is on the `work` volume, browser logins
 * on `config`, and the host's own state never enters the box. So an update is a recreate from the
 * new image with the volumes kept — Grok Bot's "Apply update" is the same move. What makes it safe
 * is the order around the recreate: wait for work in flight, recreate (pulling the image if this
 * machine does not have it), check the box that came back, and go back to the image it had if the
 * check fails. The CLI and the app's Settings → Boxes both run this function; neither has its own.
 *
 * A backup of the volumes is available and off by default: the volumes are not touched by an update,
 * so copying them every time only costs time and disk.
 */

import type { BoxStatus } from "./docker.ts";
import { join } from "node:path";
import { agentboxHome } from "../config.ts";
import { BoxManager, docker } from "./docker.ts";

export interface ImageState {
  /** The image reference the box was created from, e.g. fakechris/lumenbox:0.3.7; absent with no box. */
  runningRef?: string;
  runningId?: string;
  /** The reference this app runs its box on. */
  expectedRef: string;
  expectedId?: string;
  /** The box runs something other than what this app expects: a different tag, or the same tag rebuilt. */
  available: boolean;
  /** The expected image is not on this machine yet; the update pulls it first. */
  needsPull: boolean;
}

export async function imageState(manager: BoxManager): Promise<ImageState> {
  const expectedRef = manager.config.image;
  const running = await docker(["inspect", "--format", "{{.Config.Image}}|{{.Image}}", manager.config.containerName], 20_000).catch(() => undefined);
  const expectedId = await docker(["image", "inspect", "--format", "{{.Id}}", expectedRef], 20_000).catch(() => undefined);
  if (running === undefined) return { expectedRef, ...(expectedId !== undefined ? { expectedId } : {}), available: false, needsPull: expectedId === undefined };
  const [recorded = "", runningId = ""] = running.split("|");
  // A box that went back is recorded by image id; name it by a tag of that image when it has one.
  const tags = recorded.startsWith("sha256:") ? await docker(["image", "inspect", "--format", "{{join .RepoTags \",\"}}", runningId], 20_000).catch(() => "") : "";
  const runningRef = tags.split(",").find(tag => tag !== "") ?? recorded;
  // The id decides when the expected image is here: the same tag rebuilt is an update, and a box
  // recorded by id that runs the expected image is not.
  const available = expectedId !== undefined ? runningId !== expectedId : runningRef !== expectedRef;
  return { runningRef, runningId, expectedRef, ...(expectedId !== undefined ? { expectedId } : {}), available, needsPull: expectedId === undefined };
}

export type UpdateOutcome = "current" | "waiting" | "updated" | "rolled_back" | "failed";

export interface UpdateResult {
  outcome: UpdateOutcome;
  detail: string;
  /** What was still running, when the outcome is waiting. */
  busy?: string[];
  status?: BoxStatus;
}

export interface UpdateDeps {
  state: () => Promise<ImageState>;
  /** What an update would interrupt now: turns in flight, background jobs. Empty means go. */
  busy: () => Promise<string[]>;
  /** Recreate the box from `image` (an image id when going back), keeping its volumes. */
  recreate: (image: string | undefined, onOutput: (line: string) => void) => Promise<BoxStatus>;
  /** Why the box that came back does not work, or nothing. */
  verify: () => Promise<string | undefined>;
  backup?: () => Promise<string[]>;
  onOutput: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface UpdateOptions {
  /** Recreate even when the box already runs the expected image (`box up --recreate`). */
  force?: boolean;
  /** Wait for work in flight to finish instead of answering "waiting". */
  whenIdle?: boolean;
  maxWaitMs?: number;
  pollMs?: number;
  backup?: boolean;
}

export async function applyUpdate(deps: UpdateDeps, options: UpdateOptions = {}): Promise<UpdateResult> {
  const say = deps.onOutput;
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const before = await deps.state();
  if (!before.available && !options.force) return { outcome: "current", detail: `The box already runs ${before.expectedRef}.` };

  let busy = await deps.busy();
  if (busy.length > 0) {
    if (!options.whenIdle) return { outcome: "waiting", detail: "Work is in progress; updating now would interrupt it.", busy };
    const until = now() + (options.maxWaitMs ?? 2 * 60 * 60_000);
    say(`waiting for work in progress to finish: ${busy.join("; ")}`);
    while (busy.length > 0 && now() < until) {
      await sleep(options.pollMs ?? 30_000);
      busy = await deps.busy();
    }
    if (busy.length > 0) return { outcome: "waiting", detail: "Work was still in progress when the wait ran out.", busy };
  }

  if (options.backup && deps.backup !== undefined) {
    say("backing up the box's volumes first");
    for (const file of await deps.backup()) say(`  ${file}`);
  }

  say(`${before.needsPull ? "pulling and " : ""}recreating the box on ${before.expectedRef}; work and browser logins stay on their volumes`);
  let status: BoxStatus;
  try {
    status = await deps.recreate(undefined, say);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return goBack(deps, before, `the new box could not be created: ${why}`);
  }
  say("checking the box that came back");
  const broken = await deps.verify();
  if (broken === undefined) return { outcome: "updated", detail: `The box now runs ${before.expectedRef}.`, status };
  return goBack(deps, before, `the updated box does not work: ${broken}`);
}

/** Back to the image the box ran before, by id: always on this machine, unlike a `:previous` tag. */
async function goBack(deps: UpdateDeps, before: ImageState, why: string): Promise<UpdateResult> {
  deps.onOutput(why);
  if (before.runningId === undefined || before.runningId === "") return { outcome: "failed", detail: `${why}. There was no box before, so there is nothing to go back to.` };
  deps.onOutput(`going back to the image it had (${before.runningRef ?? before.runningId.slice(7, 19)})`);
  try {
    const status = await deps.recreate(before.runningId, deps.onOutput);
    const stillBroken = await deps.verify();
    if (stillBroken !== undefined) return { outcome: "failed", detail: `${why}; going back did not help either: ${stillBroken}` };
    return { outcome: "rolled_back", detail: `${why}. The box is back on the image it had; the new one is still broken.`, status };
  } catch (error) {
    return { outcome: "failed", detail: `${why}; going back failed too: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The dependencies for a Docker box this machine runs, shared by the CLI and the web server. */
export function dockerUpdateDeps(manager: BoxManager, extra: { busy: () => Promise<string[]>; verify: () => Promise<string | undefined>; onOutput: (line: string) => void }): UpdateDeps {
  return {
    state: () => imageState(manager),
    busy: extra.busy,
    recreate: async (image, onOutput) => (await new BoxManager(image === undefined ? manager.config : { ...manager.config, image }).up({ recreate: true, onOutput })).status,
    verify: extra.verify,
    backup: () => manager.backupVolumes(join(agentboxHome(), "backups", `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-volumes`)),
    onOutput: extra.onOutput,
  };
}

/**
 * Reset: the box made new, its volumes too — what agents made and every browser login go. A
 * different act from an update, and only ever asked for by name.
 */
export async function resetBox(manager: BoxManager, onOutput: (line: string) => void): Promise<BoxStatus> {
  onOutput(`removing ${manager.config.containerName} and its volumes`);
  await manager.down({ remove: true });
  for (const volume of ["work", "config"]) {
    const name = `${manager.config.containerName}-${volume}`;
    // A volume that will not go means the reset did not happen: say so rather than start a box on the old data.
    await docker(["volume", "rm", "--force", name], 60_000).catch(error => { throw new Error(`could not remove ${name}, so the box was not reset: ${error instanceof Error ? error.message : String(error)}`); });
  }
  return (await manager.up({ recreate: true, onOutput })).status;
}
