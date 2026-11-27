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
  | { state: "failed"; reason: string }
  | { state: "quota" };

interface Options {
  home: string;
  boxes: PersonalBoxes;
  /** The installation's setting; `never` on anything but an organisation. */
  when(): PersonalBoxAt;
  /** Signed-in, driver or above, and eligible in the directory — the create route's own test. */
  eligible(owner: string): boolean;
  quota(owner: string): number | undefined;
  /** After the box came up: what the create route does next (reconnect it). */
  ready(id: string): Promise<void>;
  log(line: string): void;
}

export class AutoPersonalBoxes {
  private readonly path: string;
  private readonly queue: Array<{ person: { id: string; name: string }; name: string }> = [];
  private starting = 0;
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
    return queued.map(person => person.id);
  }

  private drain(): void {
    while (this.starting < STARTING_AT_ONCE && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.starting += 1;
      // One person's refusal, however it comes, frees their place and never stops the rest.
      void Promise.resolve().then(() => this.make(next.person, next.name, "at activation"))
        .catch((error: unknown) => this.options.log(`personal box for ${next.person.id}: not created at activation: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { this.starting -= 1; this.drain(); });
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

  /** Reserves and starts the person's box; the promise settles when the start has ended, well or badly. Undefined when none is owed. */
  private make(person: { id: string; name: string }, name: string, when: string): Promise<void> | undefined {
    const { options } = this;
    if (!this.owed(person, when)) return undefined;
    const pending = options.boxes.create(person.id, AUTO_REQUEST, () => options.eligible(person.id), { name, ownerName: person.name });
    this.write(person.id, "created");
    return pending.then(
      (row) => {
        options.log(`personal box for ${person.id}: created ${when}, ${row.status}${row.stateReason ? ` (${row.stateReason})` : ""}`);
        if (row.status === "ready") return options.ready(row.id);
      },
      (error: unknown) => {
        // Refused before anything was reserved: a quota taken meanwhile is said like any other; any other refusal is looked at again next time.
        const full = error instanceof Error && /quota/i.test(error.message);
        this.write(person.id, full ? "quota" : undefined);
        options.log(`personal box for ${person.id}: not created ${when}: ${error instanceof Error ? error.message : String(error)}`);
      },
    ).catch((error: unknown) => options.log(`personal box for ${person.id}: reconnect failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** What the page says about it while it matters: being prepared, why it failed, or out of quota. */
  view(owner: string): AutoPersonalBoxView | undefined {
    if (this.options.when() === "never") return;
    // Waiting in the queue here is being prepared too: the page and the chat (INV-2221) say so before a box record exists.
    if (this.queue.some(entry => entry.person.id === owner)) return { state: "preparing" };
    const outcome = this.outcome(owner), box = this.options.boxes.list(owner)[0];
    // Out of quota stops mattering once the person has a box, however they got it.
    if (outcome === "quota") return box ? undefined : { state: "quota" };
    if (outcome !== "created" || !box) return;
    if (box.status === "provisioning") return { state: "preparing" };
    // Failed, interrupted by a restart, or a cleanup left half done: each waits for a person's retry, with what is known of why.
    if (box.status === "failed" || box.status === "interrupted" || (box.status === "deleting" && box.error))
      return { state: "failed", reason: box.stateReason ?? box.error ?? box.status };
  }

  /** The people whose box waits for an Admin to raise their quota. */
  waiting(): Set<string> {
    if (this.options.when() === "never") return new Set();
    const owners = this.db((db) => (db.prepare("SELECT owner FROM done WHERE outcome='quota'").all() as { owner: string }[]).map((row) => row.owner));
    return new Set(owners.filter((owner) => this.options.boxes.list(owner).length === 0));
  }
}
