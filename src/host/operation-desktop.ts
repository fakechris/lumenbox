/**
 * Desktop steps of a taught operation, run with no model (INV-1421).
 *
 * Each step becomes one computer call through computerWithVision, so it gets exactly the readings
 * and gates an agent's own call would: a click is found by description, a wait and a check read the
 * screen, and the guard reads a click before it lands. A click marked `commit` was approved with the
 * run; any other click the guard takes for send, pay or delete stops the run — the operation did not
 * declare it, so it is not what was taught.
 *
 * The readings need their switches. With them off a desktop step fails and says which switch, so an
 * operation with desktop steps cannot pass its dry run, and so cannot be published, until they are on.
 */

import type { BoxClient } from "../box/client.ts";
import type { ComputerAction } from "../protocol/index.ts";
import { type Clock, computerWithVision } from "./computer-vision.ts";
import { defaultSwitchDeps, type JevPoint, modeFor, type SwitchDeps } from "./jev.ts";
import type { DesktopRunner, DesktopVerb } from "./operation.ts";

const NEEDS: Record<DesktopVerb, JevPoint | undefined> = { click: "computer_click", type: undefined, key: undefined, wait: "computer_wait", check: "computer_wait" };

export function desktopRunner(box: Pick<BoxClient, "computer">, where: { display?: number; owner?: string }, jev: SwitchDeps = defaultSwitchDeps, clock?: Clock): DesktopRunner {
  return async ({ verb, value, seconds, committed }) => {
    const needed = NEEDS[verb];
    if (needed !== undefined && modeFor(needed, jev).mode !== "on") {
      return { ok: false, detail: `desktop ${verb} steps need AGENTBOX_JEV_${needed.toUpperCase()} on (Settings → Model → Decision model)` };
    }
    const action = (
      verb === "click" ? { action: "click_target", target: value }
      : verb === "type" ? { action: "type", text: value }
      : verb === "key" ? { action: "key", key: value }
      : { action: "wait_until", looks: value, seconds: verb === "check" ? 1 : (seconds ?? 15) }
    ) as unknown as ComputerAction;
    const guard = committed
      ? () => ({ allow: true as const })
      : (finding: string) => ({ allow: false as const, reason: `${finding}; the step is not marked commit, so the operation stops before it` });
    const result = await computerWithVision(box, [action], { ...where, guard }, jev, clock);
    if (verb === "wait" || verb === "check") {
      return result.verification?.status === "satisfied" ? { ok: true, detail: result.verification.detail } : { ok: false, detail: result.verification?.detail ?? result.error ?? "the screen could not be read" };
    }
    if (result.outcome === "refused" || result.outcome === "failed" || result.error !== undefined) return { ok: false, detail: result.error ?? `the ${verb} ${result.outcome}` };
    return { ok: true, detail: result.effect_detail ?? `${verb} sent` };
  };
}
