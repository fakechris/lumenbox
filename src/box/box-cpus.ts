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

export async function defaultCpuLimit(): Promise<string | undefined> {
  const n = await engineCpus();
  return n === undefined ? undefined : defaultCpusFor(n);
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
