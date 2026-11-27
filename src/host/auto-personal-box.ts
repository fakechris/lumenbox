import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { personalBoxesOf } from "./box-quota.ts";
import type { PersonalBoxes } from "./personal-boxes.ts";

/**
 * A member's personal box, made for them the first time they sign in to an organisation
 * installation (docs/107 §2 decision 4, §4 "Quota still decides"; INV-2203).
 *
 * "First" is a record, not "whenever they have none": once a person's box was made — or they
 * already had one — it is written down here, so a person who deletes their own box on purpose
 * is not handed another on the next page load. Out of quota is written down too, without a
 * box and without an attempt: the page says so, the Admins see it, and the person gets the box
 * at a later sign-in once an Admin has raised the quota. No creation is retried in a loop; a
 * box that failed to start stays failed, with the platform's reason, until somebody retries it.
 *
 * The box is made through `PersonalBoxes.create`, the member's own path, under one fixed
 * request id: a second tab, a second device or a second server process asking at the same time
 * gets the same box, never another.
 */
export const AUTO_REQUEST = "first-sign-in";

type Outcome = "created" | "had" | "quota";
export type AutoPersonalBoxView =
  | { state: "preparing" }
  | { state: "failed"; reason: string }
  | { state: "quota" };

interface Options {
  home: string;
  boxes: PersonalBoxes;
  /** The installation's switch: an organisation installation with `autoPersonalBox` not false. */
  enabled(): boolean;
  /** Signed-in, driver or above, and eligible in the directory — the create route's own test. */
  eligible(owner: string): boolean;
  quota(owner: string): number | undefined;
  /** After the box came up: what the create route does next (reconnect it). */
  ready(id: string): Promise<void>;
  log(line: string): void;
}

export class AutoPersonalBoxes {
  private readonly path: string;
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
    const { options } = this, boxes = options.boxes;
    if (!options.enabled() || !options.eligible(person.id)) return;
    const before = this.outcome(person.id);
    if (before === "created" || before === "had") return;
    if (boxes.known(person.id) || personalBoxesOf(boxes.quotaEntries(), person.id).length > 0) { this.write(person.id, "had"); return; }
    const quota = options.quota(person.id);
    if (quota !== undefined && quota < 1) {
      if (before !== "quota") { this.write(person.id, "quota"); options.log(`personal box for ${person.id}: not created at first sign-in, out of quota`); }
      return;
    }
    const pending = boxes.create(person.id, AUTO_REQUEST, () => options.eligible(person.id), { name, ownerName: person.name });
    this.write(person.id, "created");
    pending.then(
      (row) => {
        options.log(`personal box for ${person.id}: created at first sign-in, ${row.status}${row.stateReason ? ` (${row.stateReason})` : ""}`);
        if (row.status === "ready") return options.ready(row.id);
      },
      (error: unknown) => {
        // Refused before anything was reserved: a quota taken meanwhile is said like any other; any other refusal is looked at again next time.
        const full = error instanceof Error && /quota/i.test(error.message);
        this.write(person.id, full ? "quota" : undefined);
        options.log(`personal box for ${person.id}: not created at first sign-in: ${error instanceof Error ? error.message : String(error)}`);
      },
    ).catch((error: unknown) => options.log(`personal box for ${person.id}: reconnect failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** What the page says about it while it matters: being prepared, why it failed, or out of quota. */
  view(owner: string): AutoPersonalBoxView | undefined {
    if (!this.options.enabled()) return;
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
    if (!this.options.enabled()) return new Set();
    const owners = this.db((db) => (db.prepare("SELECT owner FROM done WHERE outcome='quota'").all() as { owner: string }[]).map((row) => row.owner));
    return new Set(owners.filter((owner) => this.options.boxes.list(owner).length === 0));
  }
}
