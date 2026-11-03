/**
 * The box's CPU ceiling (INV-1552, docs/12 §7).
 *
 * A desktop box always shares its machine. On 2026-11-03, agent scans inside one held a Mac's
 * load at 45-55 for hours and timed out its test suite, though agent work runs under nice inside
 * the box. So a box gets a ceiling unless someone chose one: half the engine's cores, at least 2.
 * It is changed in place with `docker update`, no recreate.
 */

import { docker } from "./docker.ts";

/** The engine's core count, from `docker info`; undefined when it cannot be read. */
export async function engineCpus(): Promise<number | undefined> {
  const n = Number((await docker(["info", "--format", "{{.NCPU}}"], 20_000).catch(() => "")).trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The ceiling a box gets when nobody chose one. */
export function defaultCpusFor(engine: number): string {
  return String(Math.max(2, Math.floor(engine / 2)));
}

/** The default for this engine; the floor of 2 when its core count cannot be read, rather than no ceiling. */
export async function defaultCpuLimit(): Promise<string> {
  const n = await engineCpus();
  return n === undefined ? "2" : defaultCpusFor(n);
}

/**
 * Puts the chosen ceiling (or the default) on a box that is up, when it does not have it already —
 * so a box created before ceilings existed, or one a person changed, is brought in line when it is
 * next started or reused. A failure is said, not thrown: a box without its ceiling still works.
 */
export async function ensureCpuLimit(containerName: string, chosen: string | undefined, say?: (line: string) => void): Promise<void> {
  try {
    const wanted = Number(chosen ?? (await defaultCpuLimit()));
    const current = await cpuLimitOf(containerName);
    if (current !== undefined && Math.abs(current - wanted) < 0.01) return;
    await setCpuLimit(containerName, String(wanted));
    say?.(`cpu limit: ${wanted} cores${current === undefined ? " (it had none)" : ` (it had ${current})`}`);
  } catch (error) {
    say?.(`cpu limit not applied: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The running container's ceiling, in cores; undefined for none. */
export async function cpuLimitOf(containerName: string): Promise<number | undefined> {
  const nano = Number((await docker(["inspect", "--format", "{{.HostConfig.NanoCpus}}", containerName], 20_000)).trim());
  return nano > 0 ? nano / 1e9 : undefined;
}

/** Changes a running box's ceiling in place. */
export async function setCpuLimit(containerName: string, cpus: string): Promise<void> {
  await docker(["update", "--cpus", cpus, containerName], 30_000);
}
