/**
 * What an upgrade is about to cost, asked before it is paid.
 *
 * Recreating a box destroys everything that is not on one of its volumes — that is what
 * makes it an upgrade rather than a restart. The losses are real, ordinary, and silent:
 * a background job dies leaving a log file nobody will read, and a report an agent wrote
 * to its home directory instead of its work directory simply stops existing. Neither
 * announces itself, and both are noticed days later.
 *
 * So this asks first. It does not decide — the caller does, because the right answer
 * differs between an operator at a terminal who can see the warning, an unattended
 * window at four in the morning, and a box three people are currently watching.
 *
 * Everything here goes through BoxClient rather than through Docker, so it works the same
 * for a box on this machine and a box somewhere else. The one thing that cannot is the
 * volume backup, which needs the volumes themselves; that lives with the Docker manager.
 */

import type { BoxClient } from "./client.ts";

/** How recent a file has to be for its loss to be worth mentioning. */
const RECENT_DAYS = 30;
/** Enough names to recognise what is there without printing a filesystem. */
const MAX_LISTED = 20;

export interface Preflight {
  /** Jobs still running, which recreating the box kills. */
  runningJobs: { id: string; command: string }[];
  /**
   * Recently-touched files outside the volumes, which recreating the box destroys.
   *
   * The prompt tells agents to put durable work under /home/box/work. An agent that wrote
   * a report to its home directory did not read that sentence, and this is how anyone
   * finds out before rather than after.
   */
  strayFiles: string[];
  /** True when more were found than are listed. */
  moreStrayFiles: boolean;
  /** Set when the box could not be asked, so absence of findings means nothing. */
  unknown?: string;
}

/** Whether anything here should stop an upgrade that nobody is watching. */
export function isQuiet(preflight: Preflight): boolean {
  return (
    preflight.unknown === undefined &&
    preflight.runningJobs.length === 0 &&
    preflight.strayFiles.length === 0
  );
}

/** The findings as something to show a person, or empty when there is nothing to say. */
export function describePreflight(preflight: Preflight): string {
  if (preflight.unknown !== undefined) {
    return `The box could not be checked before upgrading (${preflight.unknown}), so what an upgrade would destroy is unknown.`;
  }
  const parts: string[] = [];
  if (preflight.runningJobs.length > 0) {
    const names = preflight.runningJobs.map(job => `  ${job.id}  ${job.command}`).join("\n");
    parts.push(
      `${preflight.runningJobs.length} job(s) still running, which upgrading kills:\n${names}`
    );
  }
  if (preflight.strayFiles.length > 0) {
    parts.push(
      `Files changed in the last ${RECENT_DAYS} days outside /home/box/work and ` +
        `/home/box/.config. Only those two survive an upgrade, so these would be lost:\n` +
        preflight.strayFiles.map(path => `  ${path}`).join("\n") +
        (preflight.moreStrayFiles ? `\n  … and more` : "")
    );
  }
  return parts.join("\n\n");
}

/**
 * Asks the box what an upgrade would destroy.
 *
 * Never throws: a box too broken to answer is a box somebody may well be upgrading *to
 * fix*, and refusing to look is not a reason to refuse to proceed. The caller is told the
 * answer is unknown instead, which is a different thing from "nothing to lose" and is why
 * `unknown` exists rather than an empty result standing in for both.
 */
export async function preflight(box: BoxClient): Promise<Preflight> {
  const empty: Preflight = { runningJobs: [], strayFiles: [], moreStrayFiles: false };
  try {
    const { jobs } = await box.jobs();
    const running = jobs
      .filter(job => job.running)
      .map(job => ({ id: job.job_id, command: job.command }));

    // Pruned rather than filtered afterwards, and the list is mostly about noise rather
    // than about cost: caches and dbus sockets are always freshly touched, the Desktop
    // launchers are re-seeded from the image on every start, and /opt/boxd and /opt/hostd
    // *are* the image. Reporting those as things an upgrade would destroy is technically
    // true and useless — a warning that is mostly noise is one nobody reads, and the two
    // files that mattered were sitting in the middle of it.
    //
    // Hidden directories go as a class, the same rule the upload guard uses: they hold
    // configuration, not work somebody would miss.
    const find =
      `find /home/box /srv /opt /root -xdev \\( ` +
      `-path /home/box/work -o -path /home/box/.config -o -path /home/box/Desktop ` +
      `-o -path /opt/boxd -o -path /opt/hostd ` +
      `-o \\( -type d -name '.*' \\) -o -name node_modules -o -name .git ` +
      `\\) -prune -o -type f -mtime -${RECENT_DAYS} -print 2>/dev/null | head -${MAX_LISTED + 1}`;
    const found = await box.exec(find, { timeoutMs: 30_000 });
    const paths = found.stdout
      .split("\n")
      .map(line => line.trim())
      .filter(line => line !== "");

    return {
      runningJobs: running,
      strayFiles: paths.slice(0, MAX_LISTED),
      moreStrayFiles: paths.length > MAX_LISTED,
    };
  } catch (error) {
    return { ...empty, unknown: error instanceof Error ? error.message : String(error) };
  }
}
