import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BoxEntry } from "../box/boxes.ts";
import { personalBoxesOf } from "./box-quota.ts";

type Status = "provisioning" | "ready" | "failed" | "deleting" | "detached" | "deleted";
export interface PersonalBoxRecord {
  id: string;
  owner: string;
  request: string;
  name: string;
  tokenFile: string;
  status: Status;
  createdAt: string;
  worker?: number;
  deleteData?: boolean;
  error?: string;
}
export interface PersonalBoxDriver {
  start(record: PersonalBoxRecord): Promise<string>;
  remove(record: PersonalBoxRecord, deleteData: boolean): Promise<void>;
}
interface Options {
  home: string;
  entries(): readonly BoxEntry[];
  quota(owner: string): number | undefined;
  authorize(owner: string): boolean;
  attach(entry: BoxEntry): void;
  detach(id: string): void;
  residents(id: string): number;
  driver: PersonalBoxDriver;
}
/** Durable reservations precede Docker effects; worker ownership outlives HTTP requests. */
export class PersonalBoxes {
  private readonly path: string;
  private readonly locks = new Map<string, DatabaseSync>();
  private readonly active = new Map<string, Promise<PersonalBoxRecord>>();
  constructor(private readonly options: Options) {
    mkdirSync(options.home, { recursive: true, mode: 0o700 });
    this.path = join(options.home, "personal-boxes.sqlite");
    this.transaction((db) => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS boxes (id TEXT PRIMARY KEY, owner TEXT NOT NULL, request TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(owner,request))",
      );
    });
    chmodSync(this.path, 0o600);
  }
  /** SQLite owns the live operation lock, so process death releases it even after PID reuse. */
  private openLock(id: string): DatabaseSync | undefined {
    const path = join(this.options.home, `${id}.lock.sqlite`);
    const db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
      return db;
    } catch (error) {
      db.close();
      if ((error as { errcode?: number }).errcode === 5) return;
      throw error;
    }
  }
  private running(row: PersonalBoxRecord): boolean {
    if (this.locks.has(row.id)) return true;
    const lock = this.openLock(row.id);
    if (!lock) return true;
    lock.close();
    return false;
  }
  private acquire(id: string): void {
    const lock = this.openLock(id);
    if (!lock) throw new Error("Personal box operation is still running");
    this.locks.set(id, lock);
  }
  private release(id: string): void {
    this.locks.get(id)?.close();
    this.locks.delete(id);
  }
  private transaction<T>(action: (db: DatabaseSync) => T): T {
    const before = new Set(this.locks.keys());
    const db = new DatabaseSync(this.path);
    try {
      db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      try {
        const result = action(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        for (const id of this.locks.keys()) if (!before.has(id)) this.release(id);
        throw error;
      }
    } finally {
      db.close();
    }
  }
  private records(db: DatabaseSync): PersonalBoxRecord[] {
    return (db.prepare("SELECT data FROM boxes").all() as { data: string }[]).map(
      (row) => JSON.parse(row.data) as PersonalBoxRecord,
    );
  }
  private save(db: DatabaseSync, record: PersonalBoxRecord): void {
    db.prepare("INSERT INTO boxes VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(
      record.id,
      record.owner,
      record.request,
      JSON.stringify(record),
    );
  }
  private own(db: DatabaseSync, owner: string, id: string): PersonalBoxRecord {
    const record = this.records(db).find((row) => row.owner === owner && row.id === id);
    if (!record) throw new Error("Personal box not found");
    return record;
  }
  private entry(record: PersonalBoxRecord, baseUrl?: string): BoxEntry {
    return {
      id: record.id,
      name: record.name,
      kind: "attached",
      members: [record.owner],
      displayFloor: 1,
      workDir: "/home/box/work",
      createdAt: record.createdAt,
      ...(baseUrl ? { endpoint: { baseUrl, tokenFile: record.tokenFile } } : {}),
    };
  }
  /** Includes durable, not-yet-attached reservations so administrator allocations see the same quota. */
  quotaEntries(): BoxEntry[] {
    return this.transaction((db) => this.combined(db));
  }
  private combined(db: DatabaseSync): BoxEntry[] {
    const entries = [...this.options.entries()];
    for (const row of this.records(db))
      if (["provisioning", "ready", "deleting"].includes(row.status) && !entries.some((e) => e.id === row.id))
        entries.push(this.entry(row));
    return entries;
  }
  available(id: string): boolean {
    return this.transaction((db) => {
      const row = this.records(db).find((row) => row.id === id);
      return row === undefined || row.status === "ready";
    });
  }
  manages(id: string): boolean {
    return this.transaction((db) => this.records(db).some((row) => row.id === id));
  }
  list(
    owner: string,
  ): Array<{ id: string; name: string; status: string; error?: string; dataRetained: boolean }> {
    return this.transaction((db) =>
      this.records(db)
        .filter((row) => row.owner === owner && row.status !== "deleted")
        .map((row) => ({
          id: row.id,
          name: row.name,
          status: row.worker && !this.running(row) ? "interrupted" : row.status,
          error: row.error,
          dataRetained: row.status === "detached" || row.status === "failed",
        })),
    );
  }
  private allowed(owner: string): void {
    if (!this.options.authorize(owner)) throw new Error("Personal box permission revoked");
  }
  private reserve(db: DatabaseSync, row: PersonalBoxRecord): void {
    this.allowed(row.owner);
    const quota = this.options.quota(row.owner);
    const held = personalBoxesOf(this.combined(db), row.owner).filter((entry) => entry.id !== row.id).length;
    if (quota !== undefined && held >= quota) throw new Error("Personal box quota reached");
    row.status = "provisioning";
    row.worker = process.pid;
    delete row.error;
    this.save(db, row);
  }
  async create(
    owner: string,
    request: string,
    stillAuthorized: () => boolean = () => true,
  ): Promise<PersonalBoxRecord> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(request)) throw new Error("A request ID is required");
    let created = false;
    const row = this.transaction((db) => {
      this.allowed(owner);
      const existing = this.records(db).find((r) => r.owner === owner && r.request === request);
      if (existing) return existing;
      const id = `box_${randomUUID()}`,
        name = `personal-${id.slice(4)}`;
      const tokenFile = join(this.options.home, `${id}.token`);
      const record: PersonalBoxRecord = {
        id,
        owner,
        request,
        name,
        tokenFile,
        status: "provisioning",
        createdAt: new Date().toISOString(),
      };
      this.reserve(db, record);
      created = true;
      writeFileSync(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
      this.acquire(record.id);
      return record;
    });
    if (this.active.has(row.id)) return this.active.get(row.id)!;
    if (!created) return row;
    return this.start(row, stillAuthorized);
  }
  async retry(
    owner: string,
    id: string,
    stillAuthorized: () => boolean = () => true,
  ): Promise<PersonalBoxRecord> {
    let acquired = false;
    const row = this.transaction((db) => {
      const record = this.own(db, owner, id);
      if (record.status !== "deleting") this.allowed(owner);
      if (record.status === "deleted") throw new Error("Personal box not found");
      if (this.running(record)) return record;
      if (record.status === "ready") return record;
      acquired = true;
      if (record.status === "deleting" && this.options.residents(id))
        throw new Error("Remove agents from this box first");
      this.acquire(record.id);
      if (record.status === "deleting") {
        record.worker = process.pid;
        this.save(db, record);
        return record;
      }
      this.reserve(db, record);
      return record;
    });
    if (this.active.has(row.id)) return this.active.get(row.id)!;
    if (!acquired) return row;
    return row.status === "deleting" ? this.finishRemoval(row) : this.start(row, stillAuthorized);
  }
  private start(row: PersonalBoxRecord, stillAuthorized: () => boolean): Promise<PersonalBoxRecord> {
    const pending = this.active.get(row.id);
    if (pending) return pending;
    const operation = (async () => {
      try {
        const endpoint = await this.options.driver.start(row);
        this.transaction((db) => {
          const current = this.own(db, row.owner, row.id);
          if (!stillAuthorized()) throw new Error("Personal box permission revoked");
          this.reserve(db, current); // Recheck permission and quota after the external effect.
          const existing = this.options.entries().find((entry) => entry.id === row.id);
          if (
            existing &&
            (existing.members === "everyone" ||
              existing.members.length !== 1 ||
              existing.members[0] !== row.owner)
          )
            throw new Error("Personal box membership changed");
          this.options.attach(this.entry(row, endpoint));
          current.status = "ready";
          delete current.worker;
          this.save(db, current);
          Object.assign(row, current);
          delete row.worker;
        });
      } catch {
        this.transaction((db) => {
          row.status = "deleting";
          row.deleteData = false;
          this.save(db, row);
        });
        try {
          this.detach(row);
          await this.options.driver.remove(row, false);
          this.transaction((db) => {
            row.status = "failed";
            delete row.worker;
            row.error =
              "Start failed or permission changed. Retry or remove the box; retained data is preserved.";
            this.save(db, row);
          });
        } catch {
          this.transaction((db) => {
            row.status = "deleting";
            row.deleteData = false;
            delete row.worker;
            row.error = "Cleanup incomplete. Retry cleanup before allocating another box.";
            this.save(db, row);
          });
        }
      }
      return row;
    })();
    this.active.set(row.id, operation);
    void operation
      .finally(() => {
        this.release(row.id);
        this.active.delete(row.id);
      })
      .catch(() => {});
    return operation;
  }
  async remove(owner: string, id: string, deleteData: boolean): Promise<PersonalBoxRecord> {
    const row = this.transaction((db) => {
      const record = this.own(db, owner, id);
      if (record.status === "deleted") return record;
      if (this.running(record)) throw new Error("Personal box operation is still running");
      if (record.status === "deleting" && record.deleteData !== deleteData)
        throw new Error("Retry the pending cleanup before changing data retention.");
      if (this.options.residents(id)) throw new Error("Remove agents from this box first");
      this.acquire(record.id);
      record.status = "deleting";
      record.deleteData = deleteData;
      record.worker = process.pid;
      this.save(db, record);
      return record;
    });
    return row.status === "deleted" ? row : this.finishRemoval(row);
  }
  cleanupList(): Array<{ id: string; owner: string; name: string; status: Status }> {
    return this.transaction((db) =>
      this.records(db)
        .filter((row) => row.status !== "deleted")
        .map(({ id, owner, name, status }) => ({ id, owner, name, status })),
    );
  }
  async cleanup(id: string, deleteData: boolean): Promise<void> {
    const row = this.transaction((db) => this.records(db).find((row) => row.id === id));
    if (!row) throw new Error("Personal box not found");
    await this.remove(row.owner, id, deleteData);
  }
  private detach(row: PersonalBoxRecord): void {
    if (this.options.residents(row.id)) throw new Error("Remove agents from this box first");
    if (this.options.entries().some((entry) => entry.id === row.id)) this.options.detach(row.id);
  }
  private finishRemoval(row: PersonalBoxRecord): Promise<PersonalBoxRecord> {
    const operation = (async () => {
      try {
        this.detach(row);
        await this.options.driver.remove(row, row.deleteData === true);
        row.status = row.deleteData ? "deleted" : "detached";
        delete row.error;
      } catch {
        row.error = "Cleanup incomplete. Retry cleanup.";
      }
      delete row.worker;
      this.transaction((db) => this.save(db, row));
      return row;
    })();
    this.active.set(row.id, operation);
    void operation
      .finally(() => {
        this.release(row.id);
        this.active.delete(row.id);
      })
      .catch(() => {});
    return operation;
  }
}
