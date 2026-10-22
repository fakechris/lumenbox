import { randomUUID } from "node:crypto";
import type { DesktopResourceRuntime, DesktopProcessSnapshot } from "./desktop-resources.ts";

export interface ResourceState {
  state: "starting" | "ready" | "stopping" | "dormant" | "failed";
  generation: number;
  touched: number;
  references: number;
  pinned: boolean;
  retained?: string;
  retryReason?: string;
  snapshot?: DesktopProcessSnapshot;
  launchId?: string;
  stopping?: Promise<void>;
}

export async function stopResource(index: number, state: ResourceState, runtime: DesktopResourceRuntime,
  authorize: () => boolean, stopped: () => void): Promise<void> {
  state.retryReason = undefined;
  state.state = "stopping";
  state.stopping = (async () => {
    try {
      const result = await runtime.stop(index, state.snapshot!, authorize);
      if (result.stopped) {
        stopped();
        state.state = "dormant";
        state.snapshot = undefined;
      } else {
        state.state = result.failed ? "failed" : "ready";
        if (result.reason && authorize()) {
          if (result.retryable && !result.failed) state.retryReason = result.reason;
          else state.retained = result.reason;
        }
      }
    } catch { state.state = "failed"; state.retained = "reclamation failed; process inspection required"; }
  })();
  await state.stopping;
  state.stopping = undefined;
}

/** Controller confirms its browser has exited. Never kills a workload to make it idle. */
export async function reclaimControlled(index: number, states: Map<number, ResourceState>, runtime: DesktopResourceRuntime,
  authorized: () => boolean, busy: () => boolean, stopped: () => void) {
  if (!authorized()) return { released: false, reason: "controller generation is not revoked or reconciled" };
  let state = states.get(index);
  if (busy() || state?.references || state?.pinned || state?.state === "stopping") {
    return { released: false, reason: "desktop has an active operation, viewer or pin" };
  }
  if (!state) {
    state = { state: "ready", generation: 0, touched: runtime.now(), references: 0, pinned: false };
    states.set(index, state);
  }
  const current = state;
  const generation = ++current.generation;
  // Reserve the transition before inspection. New demand changes the generation
  // and waits for the stop; it cannot create a browser between proof and commit.
  const authorize = () => authorized() && states.get(index) === current && current.generation === generation
    && !current.references && !current.pinned && !busy();
  let finish!: () => void;
  current.state = "stopping";
  current.stopping = new Promise<void>(resolve => { finish = resolve; });
  try {
    const snapshot = await runtime.capture(index, current.launchId ?? randomUUID(), true);
    if (!authorize() || snapshot.reason) {
      current.state = "ready";
      return { released: false, reason: snapshot.reason ?? "desktop demand changed" };
    }
    current.snapshot = snapshot;
    // stopResource publishes its own promise synchronously before awaiting OS work.
    const pending = stopResource(index, current, runtime, authorize, stopped);
    await pending;
    const released = (current as ResourceState).state === "dormant";
    return { released, ...(!released ? { reason: current.retryReason ?? current.retained } : {}) };
  } catch {
    current.state = "ready";
    return { released: false, reason: "process inspection unavailable" };
  } finally { finish(); }
}
