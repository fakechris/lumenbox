/**
 * One websocket consumer per Feishu app id, machine-wide.
 *
 * Feishu treats every long connection opened with the same app id as one consumer
 * group and delivers each event to exactly one of them. Two instances — a dev run
 * and the desktop app, say — therefore *split* the traffic: each sees roughly half
 * the messages, the bot answers people at random, and nothing anywhere reports an
 * error. That failure mode is worse than a crash, so the second instance is refused
 * loudly here instead. The mature reference (hermes-agent) does the same with a
 * scoped lock; this is the smallest honest version — a pid file in the system tmp
 * directory, machine-wide on purpose: two instances in two state directories still
 * collide on the app id, because the collision is at Feishu's end, not ours.
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function lockPathFor(appId: string): string {
  // The app id is Feishu's own token format (cli_…): safe as a filename as-is.
  return join(tmpdir(), `agentbox-feishu-${appId}.lock`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else — alive either way.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes the consumer lock for an app id, or throws with who holds it.
 *
 * Returns the release function. A lock whose owner is dead is stale — the process
 * that crashed cannot release it — and is taken over; that is what the retry is for.
 */
export function acquireConsumerLock(appId: string, ownPid: number = process.pid): () => void {
  const path = lockPathFor(appId);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(ownPid));
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(path);
        } catch {
          // Already gone: releasing twice, or a takeover after a crash. Either is fine.
        }
      };
    } catch {
      let holder: number | undefined;
      try {
        holder = Number(readFileSync(path, "utf8").trim());
      } catch {
        // Unreadable is indistinguishable from stale; fall through to takeover.
      }
      if (holder !== undefined && Number.isFinite(holder) && isAlive(holder)) {
        throw new Error(
          `another process (pid ${holder}) already holds the Feishu connection for this app id. ` +
            `Feishu delivers each event to only one connection per app, so a second consumer ` +
            `silently splits the traffic. Stop the other instance, or give this one its own ` +
            `Feishu app (a dev bot in a test group).`
        );
      }
      try {
        unlinkSync(path);
      } catch {
        // Somebody else cleaned it in the same window; the retry will settle it.
      }
    }
  }
  throw new Error("could not acquire the Feishu consumer lock after clearing a stale one");
}
