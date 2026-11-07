/**
 * How a machine's native environment is started as a box (INV-438, INV-1697): the same box daemon
 * the container runs, headless, with a token of its own, the work directory and the granted roots.
 * One home for the daemon's environment, so `agentbox host up` (the person's own machine) and an
 * organisation's node (`agentbox node run`) start exactly the same thing.
 */

import { join } from "node:path";
import type { Repository } from "../host/bundles.ts";

/**
 * The daemon's environment: headless, bound to `bind` only, files and commands limited to the roots.
 * `screen` opens the machine's own screen to the computer tool (INV-1707): an organisation node's
 * choice only (`node run --screen`); `host up` never passes it, and a value inherited from the
 * caller's environment is dropped, so nothing opens a screen by accident.
 */
export function headlessBoxdEnv(base: NodeJS.ProcessEnv, input: { bind: string; port: number; token: string; workDir: string; repositories: readonly Repository[]; screen?: boolean }): NodeJS.ProcessEnv {
  const { BOXD_NATIVE_SCREEN: _inherited, ...rest } = base;
  return {
    ...rest,
    ...(input.screen === true ? { BOXD_NATIVE_SCREEN: "1" } : {}),
    BOXD_HEADLESS: "1",
    BOXD_BIND: input.bind,
    BOXD_PORT: String(input.port),
    BOXD_TOKEN: input.token,
    AGENTBOX_WORK_DIR: input.workDir,
    BOXD_JOBS_DIR: join(input.workDir, ".jobs"),
    BOXD_TEACH_DIR: join(input.workDir, "teach-sessions"),
    BOXD_REPOSITORIES: JSON.stringify(input.repositories),
    DISPLAY: "",
  };
}
