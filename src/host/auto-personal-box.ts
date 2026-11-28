import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { personalBoxesOf } from "./box-quota.ts";
import type { PersonalBoxes } from "./personal-boxes.ts";

/**
 * A member's personal box, made for them by an organisation installation: when an Admin activates
 * them (docs/109 §3, INV-2220), or the first time they open the page (INV-2203) — the installation's
 * `personalBoxAt` says which, and `never` leaves it to the member. With "at activation" the page
 * load still makes one for somebody who arrives without: the first Admin, a person let in another
 * way, a person whose quota was raised since.
 *
 * Many at once are queued: an activation of a department hands over everybody it made, and at most
 * `STARTING_AT_ONCE` boxes are being started at any moment, so one press cannot ask the cluster for
 * thirty pods in the same second. A person waiting in the queue has no box record yet; a server
 * that stops with people still queued catches up at its next start (`activated` is called again
 * with everybody activated, and whoever has an outcome written down is passed over).
 *
 * "Made for them" is a record, not "whenever they have none": once a person's box was made — or they
 * already had one — it is written down here, so a person who deletes their own box on purpose
 * is not handed another on the next page load. Out of quota is written down too, without a
 * box and without an attempt: the page says so, the Admins see it, and the person gets the box
 * at a later page load once an Admin has raised the quota. No creation is retried in a loop; a
 * box that failed to start stays failed, with the platform's reason, until somebody retries it.
 *
 * The box is made through `PersonalBoxes.create`, the member's own path, under one fixed
 * request id: a second tab, a second device or a second server process asking at the same time
 * gets the same box, never another.
 */
export const AUTO_REQUEST = "first-sign-in";
/** How many boxes made here are being started at one time. */
export const STARTING_AT_ONCE = 3;

/** When an organisation makes a member's personal box. */
export type PersonalBoxAt = "activation" | "first-use" | "never";
const WHEN: readonly string[] = ["activation", "first-use", "never"];
/**
 * The installation's setting. `autoPersonalBox` is its form before INV-2220 and is read as what it
 * meant: true, a box at the first page load; false, none. With neither, at activation where the
 * boxes are a cluster's (or a given driver's), and none where they would be this machine's Docker.
 */
export function personalBoxAt(config: { personalBoxAt?: string; autoPersonalBox?: boolean }, cluster: boolean): PersonalBoxAt {
  if (config.personalBoxAt !== undefined && WHEN.includes(config.personalBoxAt)) return config.personalBoxAt as PersonalBoxAt;
  if (config.autoPersonalBox !== undefined) return config.autoPersonalBox ? "first-use" : "never";
  return cluster ? "activation" : "never";
}

type Outcome = "created" | "had" | "quota";
export type AutoPersonalBoxView =
  | { state: "preparing" }
  | { state: "failed"; reason: string; /** The box to start again: its owner's "Try again" (INV-2311). */ id: string }
  | { state: "quota" };

interface Options {
  home: string;
  boxes: PersonalBoxes;
  /** The installation's setting; `never` on anything but an organisation. */
  when(): PersonalBoxAt;
  /** Signed-in, driver or above, and eligible in the directory — the create route's own test. */
  eligible(owner: string): boolean;
  quota(owner: string): number | undefined;
  /** After the box came up: what the create route does next (reconnect it). `atActivation`: it was made because an Admin activated the person, who is then told (INV-2220). */
  ready(id: string, atActivation: boolean): Promise<void>;
  /** Something a person's box progress shows changed: queued, started, up or failed. For the page's live view. */
  changed?(): void;
  log(line: string): void;
}

export class AutoPersonalBoxes {
  private readonly path: string;
  /** People waiting their turn: to have a box made, or (`retry`) to have the failed one started again. */
  private readonly queue: Array<{ person: { id: string; name: string }; name: string; retry?: string }> = [];
  private starting = 0;
  /** People whose box has started and whose `ready` step has not ended. */
  private readonly finishing = new Set<string>();
  constructor(private readonly options: Options) {
    mkdirSync(options.home, { recursive: true, mode: 0o700 });
    this.path = join(options.home, "auto-personal-box.sqlite");
    this.db((db) => db.exec("CREATE TABLE IF NOT EXISTS done (owner TEXT PRIMARY KEY, outcome TEXT NOT NULL, at TEXT NOT NULL)"));
    chmodSync(this.path, 0o600);
  }
  private db<T>(action: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.path);
    try {
      db.exec("PRAGMA busy_timeout=5000");
      return action(db);
    } finally {
      db.close();
    }
  }
  private outcome(owner: string): Outcome | undefined {
    return this.db((db) => (db.prepare("SELECT outcome FROM done WHERE owner=?").get(owner) as { outcome: Outcome } | undefined)?.outcome);
  }
  /** "had" never replaces "created": another process may have just reserved this person's box, and its record says it is the one made here. */
  private write(owner: string, outcome: Outcome | undefined): void {
    const guard = outcome === "had" ? " WHERE outcome<>'created'" : "";
    this.db((db) => outcome === undefined ? db.prepare("DELETE FROM done WHERE owner=?").run(owner)
      : db.prepare(`INSERT INTO done VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET outcome=excluded.outcome, at=excluded.at${guard}`).run(owner, outcome, new Date().toISOString()));
  }

  /**
   * A signed-in person asked for their state. Synchronous up to the reservation, so two requests
   * of one server cannot both get past it; the box itself comes up in the background.
   */
  arrive(person: { id: string; name: string }, name: string): void {
    if (this.options.when() !== "never") void this.make(person, name, "at first sign-in");
  }

  /**
   * An Admin activated these people (or a server start found them activated): with "at activation",
   * each who is owed a box and has none written down is queued for one. Returns who was queued.
   * Somebody out of quota is written down as such here, and not queued.
   */
  activated(people: readonly { id: string; name: string }[], nameOf: (person: { id: string; name: string }) => string): string[] {
    if (this.options.when() !== "activation") return [];
    const queued = people.filter(person => !this.queue.some(entry => entry.person.id === person.id) && this.owed(person, "at activation"));
    for (const person of queued) this.queue.push({ person, name: nameOf(person) });
    this.drain();
    if (queued.length > 0) this.options.changed?.();
    return queued.map(person => person.id);
  }

  /** Whether this person is waiting their turn in the queue. */
  queued(owner: string): boolean { return this.queue.some(entry => entry.person.id === owner); }

  /**
   * What activating these people would start now, asked before the press (docs/109 §3): a box each
   * for a driver or Admin with none, within quota, where boxes are made at activation. They need not
   * be on the roster yet: `quotaOf` reads the quota by the identity they will hold, as the directory
   * lists it — the roster's own quota calls a person it does not hold yet ineligible.
   */
  estimate(people: readonly string[], role: "viewer" | "driver" | "admin", quotaOf: (id: string) => number | undefined = this.options.quota): { boxes: number; outOfQuota: number } {
    if (this.options.when() !== "activation" || role === "viewer") return { boxes: 0, outOfQuota: 0 };
    const entries = this.options.boxes.quotaEntries();
    let boxes = 0, outOfQuota = 0;
    for (const id of people) {
      if (this.options.boxes.known(id) || personalBoxesOf(entries, id).length > 0) continue;
      const quota = quotaOf(id);
      if (quota !== undefined && quota < 1) outOfQuota += 1; else boxes += 1;
    }
    return { boxes, outOfQuota };
  }

  /**
   * An Admin asks again for boxes made at activation that failed: each goes through the same queue,
   * a few at a time. A box that failed to start, was interrupted, or whose cleanup after a failed
   * start did not finish is started again by the member's own retry; somebody whose box was never
   * reserved (their role changed while they waited) is asked for one as at activation. Returns who was queued.
   */
  retryFailed(people: readonly { id: string; name: string }[], nameOf: (person: { id: string; name: string }) => string): string[] {
    const queued: string[] = [];
    for (const person of people) {
      if (this.queued(person.id)) continue;
      const box = this.options.boxes.list(person.id).find(row => (row.status === "failed" || row.status === "interrupted" || (row.status === "deleting" && row.error !== undefined))
        && this.options.boxes.requestOf(row.id) === AUTO_REQUEST);
      if (box !== undefined) this.queue.push({ person, name: box.name, retry: box.id });
      else if (!this.options.boxes.known(person.id) && this.owed(person, "at an Admin's request")) this.queue.push({ person, name: nameOf(person) });
      else continue;
      queued.push(person.id);
    }
    this.drain();
    if (queued.length > 0) this.options.changed?.();
    return queued;
  }

  private drain(): void {
    while (this.starting < STARTING_AT_ONCE && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.starting += 1;
      // One person's refusal, however it comes, frees their place and never stops the rest.
      this.options.changed?.();
      void Promise.resolve().then(() => next.retry !== undefined ? this.restart(next.person.id, next.retry) : this.make(next.person, next.name, "at activation"))
        .catch((error: unknown) => this.options.log(`personal box for ${next.person.id}: not created at activation: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { this.starting -= 1; this.options.changed?.(); this.drain(); });
    }
  }

  /** Whether a box is to be made for this person now: eligible, none made or held before, and within quota. Writes down "had one" and "out of quota". */
  private owed(person: { id: string }, when: string): boolean {
    const { options } = this, boxes = options.boxes;
    if (!options.eligible(person.id)) return false;
    const before = this.outcome(person.id);
    if (before === "created" || before === "had") return false;
    if (boxes.known(person.id) || personalBoxesOf(boxes.quotaEntries(), person.id).length > 0) { this.write(person.id, "had"); return false; }
    const quota = options.quota(person.id);
    if (quota !== undefined && quota < 1) {
      if (before !== "quota") { this.write(person.id, "quota"); options.log(`personal box for ${person.id}: not created ${when}, out of quota`); }
      return false;
    }
    return true;
  }

  /** A failed box made at activation, started again by the member's own retry; ready as if it had come up the first time. */
  private async restart(owner: string, id: string): Promise<void> {
    let row = await this.options.boxes.retry(owner, id, () => this.options.eligible(owner));
    // A cleanup left half done is finished first, which leaves the box stopped with its data: then it is started.
    if (row.status === "detached") row = await this.options.boxes.retry(owner, id, () => this.options.eligible(owner));
    this.options.log(`personal box for ${owner}: started again at an Admin's request, ${row.status}${row.stateReason ? ` (${row.stateReason})` : ""}`);
    if (row.status !== "ready") return;
    this.finishing.add(owner);
    try { await this.options.ready(row.id, true); } finally { this.finishing.delete(owner); }
  }

  /** Reserves and starts the person's box; the promise settles when the start has ended, well or badly. Undefined when none is owed. */
  private make(person: { id: string; name: string }, name: string, when: string): Promise<void> | undefined {
    const { options } = this;
    if (!this.owed(person, when)) return undefined;
    const pending = options.boxes.create(person.id, AUTO_REQUEST, () => options.eligible(person.id), { name, ownerName: person.name });
    this.write(person.id, "created");
    return pending.then(
      (row) => {
        options.log(`personal box for ${person.id}: created ${when}, ${row.status}${row.stateReason ? ` (${row.stateReason})` : ""}`);
        // Up, and what follows is still being done (reconnecting it, making the person's agent): being prepared until that has ended (INV-2221).
        if (row.status === "ready") { this.finishing.add(person.id); return options.ready(row.id, when === "at activation"); }
      },
      (error: unknown) => {
        // Refused before anything was reserved: a quota taken meanwhile is said like any other; any other refusal is looked at again next time.
        const full = error instanceof Error && /quota/i.test(error.message);
        this.write(person.id, full ? "quota" : undefined);
        options.log(`personal box for ${person.id}: not created ${when}: ${error instanceof Error ? error.message : String(error)}`);
      },
    ).catch((error: unknown) => options.log(`personal box for ${person.id}: reconnect failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { this.finishing.delete(person.id); });
  }

  /** What the page says about it while it matters: being prepared, why it failed, or out of quota. */
  view(owner: string): AutoPersonalBoxView | undefined {
    if (this.options.when() === "never") return;
    // Waiting in the queue here is being prepared too: the page and the chat (INV-2221) say so before a box record exists.
    if (this.queue.some(entry => entry.person.id === owner) || this.finishing.has(owner)) return { state: "preparing" };
    const outcome = this.outcome(owner), box = this.options.boxes.list(owner)[0];
    // Out of quota stops mattering once the person has a box, however they got it.
    if (outcome === "quota") return box ? undefined : { state: "quota" };
    if (outcome !== "created" || !box) return;
    if (box.status === "provisioning") return { state: "preparing" };
    // Failed, interrupted by a restart, or a cleanup left half done: each waits for a person's retry, with what is known of why.
    if (box.status === "failed" || box.status === "interrupted" || (box.status === "deleting" && box.error))
      return { state: "failed", reason: box.stateReason ?? box.error ?? box.status, id: box.id };
  }

  /** The people whose box waits for an Admin to raise their quota. */
  waiting(): Set<string> {
    if (this.options.when() === "never") return new Set();
    const owners = this.db((db) => (db.prepare("SELECT owner FROM done WHERE outcome='quota'").all() as { owner: string }[]).map((row) => row.owner));
    return new Set(owners.filter((owner) => this.options.boxes.list(owner).length === 0));
  }
}
