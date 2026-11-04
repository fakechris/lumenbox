/**
 * Starting the box's container, and what to do when `docker run` does not say how it went (INV-1561).
 *
 * On 2026-11-04 an update's `docker run --detach` created the container and then never returned;
 * after two minutes the CLI was killed (exit 143) and the update went back to the old image. That
 * `docker run` failed on the name — the half-made container still held it — and the box was down
 * until the keeper happened to start the leftover, which was the new image all along: "failed, and
 * going back failed too" for an update that had worked. So:
 *
 * - before running, a container left with this name is removed: `up` only runs one when it found
 *   none, so anything there is a leftover the state read did not see;
 * - after a failed run, the container's real state decides, read for a short while because a
 *   stuck engine catches up: running is a box; created or exited is started; anything else is
 *   removed and the run's error stands, so whoever goes back finds the name free.
 */

export type RunState = "missing" | "created" | "running" | "paused" | "restarting" | "exited" | "dead" | string;

export interface RunContainerDeps {
  run: () => Promise<unknown>;
  state: () => Promise<RunState>;
  start: () => Promise<unknown>;
  remove: () => Promise<unknown>;
  say?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long a failed run's container is watched for before it is given up on. */
  settleMs?: number;
  pollMs?: number;
  now?: () => number;
}

export type RunOutcome = "ran" | "running after a failed run" | "started after a failed run";

export async function runContainer(deps: RunContainerDeps): Promise<RunOutcome> {
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  await deps.remove().catch(() => undefined); // nothing there is the usual answer
  try {
    await deps.run();
    return "ran";
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    deps.say?.(`docker run did not finish cleanly (${why.slice(0, 200)}); checking what it left`);
    const until = now() + (deps.settleMs ?? 30_000);
    let started = false;
    for (;;) {
      const state = await deps.state().catch(() => "unknown");
      if (state === "running") {
        deps.say?.("the container it created is running; carrying on with it");
        return started ? "started after a failed run" : "running after a failed run";
      }
      if ((state === "created" || state === "exited") && !started) {
        started = true;
        deps.say?.(`the container it created is ${state}; starting it`);
        await deps.start().catch((startError: unknown) => deps.say?.(`could not start it: ${startError instanceof Error ? startError.message : String(startError)}`));
        continue;
      }
      if (state === "missing" || now() >= until) break;
      await sleep(deps.pollMs ?? 2_000);
    }
    deps.say?.("removing what the failed run left, so the name is free");
    await deps.remove().catch(() => undefined);
    throw error;
  }
}
