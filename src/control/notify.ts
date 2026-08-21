/**
 * Telling someone when a box's state changes.
 *
 * Everything in this system was pull-only. Health, crashes and degraded desktops were all recorded
 * faithfully and reported to whoever asked — and nobody asks at three in the morning. An agent
 * working overnight whose x11vnc crash-loops keeps working, keeps returning screenshots (those go
 * through X, not VNC), and is only discovered to be unwatchable when someone tries to watch it.
 *
 * **Only on change.** A notice every sweep is a notice nobody reads, and the first thing an operator
 * does with one is mute it — after which the system is worse off than with no notifications at all,
 * because now there is a channel everyone believes is working. So this fires on a transition and
 * says which transition it was.
 *
 * **Recovery is a notice too.** "It came back" is the thing you most want at three in the morning
 * and the thing systems most often leave out, so an alert that never clears trains people to ignore
 * the ones that do matter.
 *
 * The delivery mechanism is a function. A webhook, a log line, a file, a pager — that is the
 * operator's business and not something to have an opinion about here.
 */

/** What happened, in the form a person needs to decide whether to get up. */
export interface BoxNotice {
  boxId: string;
  /** The container's name, which is what an operator will type next. */
  externalId: string;
  tenantId: string;
  kind: "unreachable" | "recovered" | "degraded" | "undegraded";
  /** One line, written to be read on a phone. */
  text: string;
  at: string;
}

/** What a box was last seen as, so a transition can be recognised. */
type Seen = { reachable: boolean; degraded: boolean };

export type Deliver = (notice: BoxNotice) => void;

export class HealthNotifier {
  private readonly seen = new Map<string, Seen>();

  constructor(private readonly deliver: Deliver) {}

  /**
   * Records what a box is now, and delivers a notice if that is different from what it was.
   *
   * The first observation of a box is deliberately silent when it is healthy and loud when it is
   * not: starting a control plane should not page anyone about every box that is fine, but a box
   * that is already broken when we first look at it is news.
   */
  observe(box: { id: string; externalId: string; tenantId: string }, now: Seen, at = new Date()): void {
    const before = this.seen.get(box.id);
    this.seen.set(box.id, now);

    const notice = (kind: BoxNotice["kind"], text: string): void => {
      this.deliver({
        boxId: box.id,
        externalId: box.externalId,
        tenantId: box.tenantId,
        kind,
        text,
        at: at.toISOString(),
      });
    };

    if (before === undefined) {
      if (!now.reachable) {
        notice("unreachable", `${box.externalId} is not answering, and was already down when this control plane started.`);
      } else if (now.degraded) {
        notice(
          "degraded",
          `${box.externalId} is answering but part of its desktop is not working, and already was ` +
            `when this control plane started. Agents will keep working; nobody can watch them.`
        );
      }
      return;
    }

    if (before.reachable && !now.reachable) {
      notice("unreachable", `${box.externalId} has stopped answering. Work on it is not happening.`);
      return;
    }
    if (!before.reachable && now.reachable) {
      notice("recovered", `${box.externalId} is answering again.`);
      // Its desktop state is reported below if it also changed, so a box that comes back broken
      // does not read as fully recovered.
    }

    const wasDegraded = before.reachable && before.degraded;
    if (now.reachable && !wasDegraded && now.degraded) {
      notice(
        "degraded",
        `${box.externalId} is answering but part of its desktop is not working. Agents will keep ` +
          `working and screenshots will keep arriving — those go through X — but nobody can watch ` +
          `them live.`
      );
    } else if (now.reachable && wasDegraded && !now.degraded) {
      notice("undegraded", `${box.externalId}'s desktop is working again.`);
    }
  }

  /** Stops tracking a box that no longer exists, so its removal is not read as a recovery. */
  forget(boxId: string): void {
    this.seen.delete(boxId);
  }
}

/**
 * Posts a notice to a URL, and never lets that failure become the caller's problem.
 *
 * A notifier that throws into a collector sweep would take out the thing that noticed the problem,
 * which is the worst possible failure mode for this particular component.
 */
export function webhookDelivery(url: string, log: (line: string) => void): Deliver {
  return notice => {
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(notice),
    }).catch(error => {
      log(
        `could not deliver a ${notice.kind} notice for ${notice.externalId}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    });
  };
}
