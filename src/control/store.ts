/**
 * The control plane's memory.
 *
 * This is the first place in the system where a real database is the right answer, and the reason is
 * specific: the box never initiates contact ([../docs/08-control-plane.md](../docs/08-control-plane.md)
 * §2), so nothing can be discovered from the fleet. A box cannot say whose it is. If this store is
 * lost, every running box keeps serving whoever holds its tokens and nothing knows who that should
 * be. That makes this the one piece of state that must be durable.
 *
 * Choices worth defending:
 *
 *   - **SQLite via `node:sqlite`.** No new dependency and no server to operate, which keeps the
 *     control plane as easy to run as the box. Behind an interface, so Postgres is a second
 *     implementation rather than a rewrite — the same move that made the box provisioner
 *     replaceable, and the only kind of seam that is worth drawing before it is needed.
 *   - **One box per tenant is a database constraint, not a convention.** A partial unique index
 *     enforces it, so a racing double `allocate` fails on the insert instead of quietly producing
 *     two boxes and two bills. Idempotency that depends on the caller checking first is not
 *     idempotency.
 *   - **Usage is keyed by `(box_id, seq)` and inserted with `or ignore`.** The box keeps an
 *     append-only record with monotonic sequence numbers (R-03); the collector remembers an offset.
 *     Together with this key, at-least-once collection becomes exactly-once storage — a collector
 *     that crashes mid-batch and re-reads cannot double-bill anyone.
 *   - **Usage is never aggregated in place.** Totals are queries. A metering bug then loses a
 *     report rather than the history.
 *   - **Tokens are encrypted at rest**, so a copy of the `.db` file is not a credential dump. The
 *     key lives beside it (§ `keyPath`), which means a backup of the whole directory *is* — stated
 *     rather than pretended away.
 *   - **Audit from the start.** A control plane without one cannot answer the first question asked
 *     after an incident.
 */

import { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type TenantState = "active" | "suspended";
export type BoxState = "starting" | "ready" | "stopped" | "unreachable" | "gone";
/**
 * The three credentials a box has, each with a different holder.
 *
 * `box` is presented to boxd by whatever drives the desktop. `ui` is what the gateway injects when
 * proxying a person to the box's own web UI. `relay` is what the box presents to the model relay in
 * place of a provider key — a third kind rather than a reuse of one of the others, so that revoking
 * a box's ability to spend money does not also lock its owner out of watching it.
 */
export type TokenKind = "box" | "ui" | "relay";

/**
 * What a person may do inside one tenant.
 *
 * `viewer` exists because the product's promise is "watch and take over", and there is a real need
 * to let someone watch *without* the ability to take over — a reviewer, an auditor, a customer.
 */
export type Role = "owner" | "member" | "viewer";

export const ROLES: readonly Role[] = ["owner", "member", "viewer"];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export interface AppUser {
  id: string;
  username: string;
  state: "active" | "suspended";
  createdAt: string;
}

export interface Membership {
  userId: string;
  username: string;
  tenantId: string;
  role: Role;
  createdAt: string;
}

export interface Tenant {
  id: string;
  name: string;
  state: TenantState;
  createdAt: string;
  /** Shape deliberately open: limits will change faster than a migration per experiment. */
  quota: Record<string, unknown>;
}

export interface BoxRow {
  id: string;
  tenantId: string;
  allocatorKind: string;
  /** Container or pod name — what the allocator uses to find it again. */
  externalId: string;
  boxdUrl: string;
  uiUrl: string;
  state: BoxState;
  image: string;
  createdAt: string;
  lastSeenAt: string | undefined;
  /** The last usage sequence number collected from this box. */
  usageCursor: number;
}

export interface UsageRow {
  boxId: string;
  tenantId: string;
  /** The box's own sequence number. With `boxId`, the natural key that makes collection safe. */
  seq: number;
  at: string;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface RelayUsageRow {
  id: number;
  boxId: string;
  tenantId: string;
  at: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UsageTotals {
  records: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface HealthRow {
  boxId: string;
  at: string;
  ok: boolean;
  /** Working, but not fully: a box with a dead compositor still serves. */
  degraded: boolean;
  components: unknown;
  crashes: unknown;
}

export interface AuditEntry {
  tenantId: string | undefined;
  /** Who did it: a person, or the name of the loop that did it unattended. */
  actor: string;
  action: string;
  target: string;
  detail?: unknown;
}

export interface AuditRow extends AuditEntry {
  id: string;
  at: string;
}

/**
 * What the control plane needs to remember, with no mention of how.
 *
 * Written as one interface rather than several because the alternative — a repository per table —
 * spreads the transactional boundary across objects that then have to agree about it.
 */
export interface ControlStore {
  upsertTenant(input: { id?: string; name: string; quota?: Record<string, unknown> }): Tenant;

  upsertUser(input: { id?: string; username: string }): AppUser;
  getUser(id: string): AppUser | undefined;
  findUserByName(username: string): AppUser | undefined;
  setUserState(id: string, state: "active" | "suspended"): void;

  /**
   * Records that a person belongs to a tenant, in a role. Idempotent, updating the role.
   *
   * Returns the membership, which is what a session is built from.
   */
  putMembership(userId: string, tenantId: string, role: Role): Membership;
  membership(userId: string, tenantId: string): Membership | undefined;
  /** Every tenant this person belongs to — which is what a person picks from when signing in. */
  membershipsOf(userId: string): Membership[];
  /** Everyone in this tenant, for the admin surface. */
  membersOf(tenantId: string): Membership[];
  removeMembership(userId: string, tenantId: string): boolean;
  getTenant(id: string): Tenant | undefined;
  listTenants(): Tenant[];
  setTenantState(id: string, state: TenantState): void;

  /** Claims the tenant's single box slot. Throws if one is already claimed. */
  createBox(row: Omit<BoxRow, "lastSeenAt" | "usageCursor">): BoxRow;
  getBox(id: string): BoxRow | undefined;
  boxForTenant(tenantId: string): BoxRow | undefined;
  listBoxes(states?: readonly BoxState[]): BoxRow[];
  setBoxState(id: string, state: BoxState): void;
  /** Corrects where a box is reachable, after a restart moved its published ports. */
  updateBoxLocation(id: string, boxdUrl: string, uiUrl: string): void;
  markBoxSeen(id: string, at?: Date): void;

  putToken(boxId: string, kind: TokenKind, value: string): void;
  readToken(boxId: string, kind: TokenKind): string | undefined;

  /** One transaction, ignoring rows already stored. Returns how many were new. */
  appendUsage(rows: readonly UsageRow[]): number;
  setUsageCursor(boxId: string, seq: number): void;
  tenantTotals(tenantId: string, since?: string): UsageTotals;

  /** One row per request the relay forwarded, measured as it passed. */
  appendRelayUsage(row: Omit<RelayUsageRow, "id">): void;
  relayTotals(tenantId: string, since?: string): UsageTotals;
  /** Whether this tenant has any relay-measured usage, which decides which series to bill from. */
  hasRelayUsage(tenantId: string): boolean;

  recordHealth(row: HealthRow): void
  latestHealth(boxId: string): HealthRow | undefined;

  audit(entry: AuditEntry): void;
  recentAudit(limit?: number): AuditRow[];

  close(): void;
}

/**
 * Where the tokens' key lives.
 *
 * Minted on first use and stored 0600, the way the box token already is — so encryption is on by
 * default rather than being a thing an operator remembers to turn on. `AGENTBOX_CONTROL_KEY`
 * (64 hex characters) overrides it, which is how a real deployment keeps the key out of the
 * directory it backs up.
 */
export function loadEncryptionKey(keyPath: string): Buffer {
  const fromEnv = process.env.AGENTBOX_CONTROL_KEY;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const key = Buffer.from(fromEnv.trim(), "hex");
    if (key.length !== 32) {
      throw new Error("AGENTBOX_CONTROL_KEY must be 64 hex characters (32 bytes)");
    }
    return key;
  }
  if (existsSync(keyPath)) {
    const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex");
    if (key.length === 32) return key;
    throw new Error(`${keyPath} does not contain a 32-byte hex key; move it aside to mint a new one`);
  }
  const key = randomBytes(32);
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key.toString("hex"), { encoding: "utf8", mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return key;
}

/** AES-256-GCM: authenticated, so a tampered row fails loudly instead of decrypting to rubbish. */
function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${body.toString("base64")}`;
}

function decrypt(key: Buffer, stored: string): string {
  const [version, iv, tag, body] = stored.split(":");
  if (version !== "v1" || iv === undefined || tag === undefined || body === undefined) {
    throw new Error("stored token is not in the expected format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

const SCHEMA = `
create table if not exists tenant (
  id          text primary key,
  name        text not null unique,
  state       text not null default 'active',
  created_at  text not null,
  quota_json  text not null default '{}'
);

-- A person, distinct from a tenant. One person may work with more than one team, which is the
-- ordinary case for a contractor rather than an exotic one, so identity and tenancy are separate
-- tables joined by a membership.
create table if not exists app_user (
  id         text primary key,
  username   text not null unique,
  created_at text not null,
  state      text not null default 'active'
);

create table if not exists membership (
  user_id    text not null references app_user(id),
  tenant_id  text not null references tenant(id),
  -- owner | member | viewer. Three, because two is not enough and four is unexplainable.
  role       text not null,
  created_at text not null,
  primary key (user_id, tenant_id)
);

create index if not exists membership_by_tenant on membership(tenant_id);

create table if not exists box (
  id             text primary key,
  tenant_id      text not null references tenant(id),
  allocator_kind text not null,
  external_id    text not null,
  boxd_url       text not null,
  ui_url         text not null,
  state          text not null,
  image          text not null,
  created_at     text not null,
  last_seen_at   text,
  usage_cursor   integer not null default 0
);

-- One live box per tenant, enforced here rather than trusted to the allocator: a retried
-- allocate after a timeout is the normal case, and two boxes for one tenant is two bills.
create unique index if not exists box_one_live_per_tenant
  on box(tenant_id) where state <> 'gone';

create table if not exists box_token (
  box_id     text not null references box(id),
  kind       text not null,
  value_enc  text not null,
  created_at text not null,
  primary key (box_id, kind)
);

create table if not exists usage (
  box_id             text not null references box(id),
  seq                integer not null,
  tenant_id          text not null,
  at                 text not null,
  agent_id           text not null,
  model              text not null,
  input_tokens       integer not null,
  output_tokens      integer not null,
  cache_read_tokens  integer not null,
  cache_write_tokens integer not null,
  -- The box's own sequence number. Makes re-reading a batch free instead of double-billing.
  primary key (box_id, seq)
);

create index if not exists usage_by_tenant on usage(tenant_id, at);

-- Usage as the relay measured it, kept apart from what the box reported.
--
-- A separate table rather than a column, because these are two measurements with different trust:
-- the box reports its own spend, the relay observes it. Mixing them in one table would need a
-- discriminator on the primary key and would invite a total that sums both and double-counts. Kept
-- apart, "prefer the relay where it exists" is a choice the meter makes explicitly.
--
-- No sequence number: nothing pulls this with a cursor, because the relay writes it directly.
create table if not exists relay_usage (
  id                 integer primary key autoincrement,
  box_id             text not null,
  tenant_id          text not null,
  at                 text not null,
  provider           text not null,
  model              text not null,
  input_tokens       integer not null,
  output_tokens      integer not null,
  cache_read_tokens  integer not null,
  cache_write_tokens integer not null
);

create index if not exists relay_usage_by_tenant on relay_usage(tenant_id, at);

create table if not exists health (
  box_id          text not null references box(id),
  at              text not null,
  ok              integer not null,
  degraded        integer not null,
  components_json text not null,
  crashes_json    text not null,
  primary key (box_id, at)
);

create table if not exists audit (
  id          text primary key,
  tenant_id   text,
  actor       text not null,
  action      text not null,
  target      text not null,
  at          text not null,
  detail_json text
);

create index if not exists audit_by_time on audit(at);
`;

export interface SqliteStoreOptions {
  /** `:memory:` in tests. A path anywhere else. */
  path: string;
  /** Defaults to `<dir of path>/control-key`. */
  keyPath?: string;
}

export class SqliteControlStore implements ControlStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;

  constructor(options: SqliteStoreOptions) {
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    this.db = new DatabaseSync(options.path);
    // WAL so a reader — the UI asking for totals — never blocks the collector writing them.
    if (options.path !== ":memory:") this.db.exec("pragma journal_mode = wal");
    this.db.exec("pragma foreign_keys = on");
    this.db.exec(SCHEMA);
    this.key = loadEncryptionKey(
      options.keyPath ??
        (options.path === ":memory:" ? join(process.cwd(), ".control-key") : `${options.path}.key`)
    );
  }

  // ── tenants ───────────────────────────────────────────────────────────────────────

  upsertTenant(input: { id?: string; name: string; quota?: Record<string, unknown> }): Tenant {
    const existing = this.db
      .prepare("select id from tenant where name = ?")
      .get(input.name) as { id: string } | undefined;
    const id = input.id ?? existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into tenant (id, name, state, created_at, quota_json) values (?, ?, 'active', ?, ?)
         on conflict(id) do update set name = excluded.name, quota_json = excluded.quota_json`
      )
      .run(id, input.name, now, JSON.stringify(input.quota ?? {}));
    return this.getTenant(id)!;
  }

  getTenant(id: string): Tenant | undefined {
    const row = this.db.prepare("select * from tenant where id = ?").get(id) as
      | Record<string, string>
      | undefined;
    return row === undefined ? undefined : this.toTenant(row);
  }

  listTenants(): Tenant[] {
    return (
      this.db.prepare("select * from tenant order by created_at").all() as Record<string, string>[]
    ).map(row => this.toTenant(row));
  }

  setTenantState(id: string, state: TenantState): void {
    this.db.prepare("update tenant set state = ? where id = ?").run(state, id);
  }

  private toTenant(row: Record<string, string>): Tenant {
    return {
      id: row.id!,
      name: row.name!,
      state: row.state as TenantState,
      createdAt: row.created_at!,
      // A hand-edited quota should not take the control plane down with it.
      quota: parseJson(row.quota_json, {}) as Record<string, unknown>,
    };
  }

  // ── people ────────────────────────────────────────────────────────────────────────

  upsertUser(input: { id?: string; username: string }): AppUser {
    const existing = this.findUserByName(input.username);
    const id = input.id ?? existing?.id ?? randomUUID();
    this.db
      .prepare(
        `insert into app_user (id, username, created_at, state) values (?, ?, ?, 'active')
         on conflict(id) do update set username = excluded.username`
      )
      .run(id, input.username, new Date().toISOString());
    return this.getUser(id)!;
  }

  getUser(id: string): AppUser | undefined {
    const row = this.db.prepare("select * from app_user where id = ?").get(id) as
      | Record<string, string>
      | undefined;
    return row === undefined ? undefined : toUser(row);
  }

  findUserByName(username: string): AppUser | undefined {
    const row = this.db.prepare("select * from app_user where username = ?").get(username) as
      | Record<string, string>
      | undefined;
    return row === undefined ? undefined : toUser(row);
  }

  setUserState(id: string, state: "active" | "suspended"): void {
    this.db.prepare("update app_user set state = ? where id = ?").run(state, id);
  }

  putMembership(userId: string, tenantId: string, role: Role): Membership {
    this.db
      .prepare(
        `insert into membership (user_id, tenant_id, role, created_at) values (?, ?, ?, ?)
         on conflict(user_id, tenant_id) do update set role = excluded.role`
      )
      .run(userId, tenantId, role, new Date().toISOString());
    return this.membership(userId, tenantId)!;
  }

  membership(userId: string, tenantId: string): Membership | undefined {
    const row = this.db
      .prepare(
        `select m.*, u.username from membership m join app_user u on u.id = m.user_id
         where m.user_id = ? and m.tenant_id = ?`
      )
      .get(userId, tenantId) as Record<string, string> | undefined;
    return row === undefined ? undefined : toMembership(row);
  }

  membershipsOf(userId: string): Membership[] {
    return (
      this.db
        .prepare(
          `select m.*, u.username from membership m join app_user u on u.id = m.user_id
           where m.user_id = ? order by m.created_at`
        )
        .all(userId) as Record<string, string>[]
    ).map(toMembership);
  }

  membersOf(tenantId: string): Membership[] {
    return (
      this.db
        .prepare(
          `select m.*, u.username from membership m join app_user u on u.id = m.user_id
           where m.tenant_id = ? order by u.username`
        )
        .all(tenantId) as Record<string, string>[]
    ).map(toMembership);
  }

  removeMembership(userId: string, tenantId: string): boolean {
    const result = this.db
      .prepare("delete from membership where user_id = ? and tenant_id = ?")
      .run(userId, tenantId);
    return Number(result.changes) > 0;
  }

  // ── boxes ─────────────────────────────────────────────────────────────────────────

  createBox(row: Omit<BoxRow, "lastSeenAt" | "usageCursor">): BoxRow {
    this.db
      .prepare(
        `insert into box (id, tenant_id, allocator_kind, external_id, boxd_url, ui_url, state,
                          image, created_at, usage_cursor)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        row.id,
        row.tenantId,
        row.allocatorKind,
        row.externalId,
        row.boxdUrl,
        row.uiUrl,
        row.state,
        row.image,
        row.createdAt
      );
    return this.getBox(row.id)!;
  }

  getBox(id: string): BoxRow | undefined {
    const row = this.db.prepare("select * from box where id = ?").get(id) as
      | Record<string, string | number | null>
      | undefined;
    return row === undefined ? undefined : toBox(row);
  }

  boxForTenant(tenantId: string): BoxRow | undefined {
    const row = this.db
      .prepare("select * from box where tenant_id = ? and state <> 'gone'")
      .get(tenantId) as Record<string, string | number | null> | undefined;
    return row === undefined ? undefined : toBox(row);
  }

  listBoxes(states?: readonly BoxState[]): BoxRow[] {
    const rows =
      states === undefined || states.length === 0
        ? (this.db.prepare("select * from box order by created_at").all() as Record<
            string,
            string | number | null
          >[])
        : (this.db
            .prepare(
              `select * from box where state in (${states.map(() => "?").join(",")}) order by created_at`
            )
            .all(...states) as Record<string, string | number | null>[]);
    return rows.map(toBox);
  }

  setBoxState(id: string, state: BoxState): void {
    this.db.prepare("update box set state = ? where id = ?").run(state, id);
  }

  updateBoxLocation(id: string, boxdUrl: string, uiUrl: string): void {
    this.db
      .prepare("update box set boxd_url = ?, ui_url = ? where id = ?")
      .run(boxdUrl, uiUrl, id);
  }

  markBoxSeen(id: string, at = new Date()): void {
    this.db.prepare("update box set last_seen_at = ? where id = ?").run(at.toISOString(), id);
  }

  // ── tokens ────────────────────────────────────────────────────────────────────────

  putToken(boxId: string, kind: TokenKind, value: string): void {
    this.db
      .prepare(
        `insert into box_token (box_id, kind, value_enc, created_at) values (?, ?, ?, ?)
         on conflict(box_id, kind) do update set value_enc = excluded.value_enc,
                                                created_at = excluded.created_at`
      )
      .run(boxId, kind, encrypt(this.key, value), new Date().toISOString());
  }

  readToken(boxId: string, kind: TokenKind): string | undefined {
    const row = this.db
      .prepare("select value_enc from box_token where box_id = ? and kind = ?")
      .get(boxId, kind) as { value_enc: string } | undefined;
    return row === undefined ? undefined : decrypt(this.key, row.value_enc);
  }

  // ── usage ─────────────────────────────────────────────────────────────────────────

  appendUsage(rows: readonly UsageRow[]): number {
    if (rows.length === 0) return 0;
    const insert = this.db.prepare(
      `insert or ignore into usage
         (box_id, seq, tenant_id, at, agent_id, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // One transaction: a collector that dies mid-batch leaves the cursor and the rows agreeing.
    this.db.exec("begin");
    try {
      let inserted = 0;
      for (const row of rows) {
        const result = insert.run(
          row.boxId,
          row.seq,
          row.tenantId,
          row.at,
          row.agentId,
          row.model,
          row.inputTokens,
          row.outputTokens,
          row.cacheReadTokens,
          row.cacheWriteTokens
        );
        inserted += Number(result.changes);
      }
      const highest = rows.reduce((max, row) => Math.max(max, row.seq), 0);
      this.db
        .prepare("update box set usage_cursor = max(usage_cursor, ?) where id = ?")
        .run(highest, rows[0]!.boxId);
      this.db.exec("commit");
      return inserted;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  setUsageCursor(boxId: string, seq: number): void {
    this.db
      .prepare("update box set usage_cursor = max(usage_cursor, ?) where id = ?")
      .run(seq, boxId);
  }

  tenantTotals(tenantId: string, since?: string): UsageTotals {
    const row = this.db
      .prepare(
        `select count(*) as records,
                coalesce(sum(input_tokens), 0) as input_tokens,
                coalesce(sum(output_tokens), 0) as output_tokens,
                coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
                coalesce(sum(cache_write_tokens), 0) as cache_write_tokens
         from usage where tenant_id = ? and at >= ?`
      )
      .get(tenantId, since ?? "") as Record<string, number>;
    return {
      records: Number(row.records),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheWriteTokens: Number(row.cache_write_tokens),
    };
  }

  appendRelayUsage(row: Omit<RelayUsageRow, "id">): void {
    this.db
      .prepare(
        `insert into relay_usage
           (box_id, tenant_id, at, provider, model,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.boxId,
        row.tenantId,
        row.at,
        row.provider,
        row.model,
        row.inputTokens,
        row.outputTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens
      );
  }

  relayTotals(tenantId: string, since?: string): UsageTotals {
    const row = this.db
      .prepare(
        `select count(*) as records,
                coalesce(sum(input_tokens), 0) as input_tokens,
                coalesce(sum(output_tokens), 0) as output_tokens,
                coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
                coalesce(sum(cache_write_tokens), 0) as cache_write_tokens
         from relay_usage where tenant_id = ? and at >= ?`
      )
      .get(tenantId, since ?? "") as Record<string, number>;
    return {
      records: Number(row.records),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cacheReadTokens: Number(row.cache_read_tokens),
      cacheWriteTokens: Number(row.cache_write_tokens),
    };
  }

  hasRelayUsage(tenantId: string): boolean {
    const row = this.db
      .prepare("select 1 as found from relay_usage where tenant_id = ? limit 1")
      .get(tenantId) as { found?: number } | undefined;
    return row !== undefined;
  }

  // ── health ────────────────────────────────────────────────────────────────────────

  recordHealth(row: HealthRow): void {
    this.db
      .prepare(
        `insert or replace into health (box_id, at, ok, degraded, components_json, crashes_json)
         values (?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.boxId,
        row.at,
        row.ok ? 1 : 0,
        row.degraded ? 1 : 0,
        JSON.stringify(row.components ?? null),
        JSON.stringify(row.crashes ?? null)
      );
  }

  latestHealth(boxId: string): HealthRow | undefined {
    const row = this.db
      .prepare("select * from health where box_id = ? order by at desc limit 1")
      .get(boxId) as Record<string, string | number> | undefined;
    if (row === undefined) return undefined;
    return {
      boxId: String(row.box_id),
      at: String(row.at),
      ok: Number(row.ok) === 1,
      degraded: Number(row.degraded) === 1,
      components: parseJson(String(row.components_json), null),
      crashes: parseJson(String(row.crashes_json), null),
    };
  }

  // ── audit ─────────────────────────────────────────────────────────────────────────

  audit(entry: AuditEntry): void {
    this.db
      .prepare(
        `insert into audit (id, tenant_id, actor, action, target, at, detail_json)
         values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        entry.tenantId ?? null,
        entry.actor,
        entry.action,
        entry.target,
        new Date().toISOString(),
        entry.detail === undefined ? null : JSON.stringify(entry.detail)
      );
  }

  recentAudit(limit = 100): AuditRow[] {
    return (
      this.db.prepare("select * from audit order by at desc limit ?").all(limit) as Record<
        string,
        string | null
      >[]
    ).map(row => ({
      id: row.id!,
      tenantId: row.tenant_id ?? undefined,
      actor: row.actor!,
      action: row.action!,
      target: row.target!,
      at: row.at!,
      detail: row.detail_json === null ? undefined : parseJson(row.detail_json!, undefined),
    }));
  }

  close(): void {
    this.db.close();
  }
}

function toUser(row: Record<string, string>): AppUser {
  return {
    id: row.id!,
    username: row.username!,
    state: row.state === "suspended" ? "suspended" : "active",
    createdAt: row.created_at!,
  };
}

function toMembership(row: Record<string, string>): Membership {
  return {
    userId: row.user_id!,
    username: row.username!,
    tenantId: row.tenant_id!,
    // A hand-edited role should not become an accidental owner. Anything unrecognised reads as the
    // least privilege, not the most.
    role: isRole(row.role!) ? row.role : "viewer",
    createdAt: row.created_at!,
  };
}

function toBox(row: Record<string, string | number | null>): BoxRow {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    allocatorKind: String(row.allocator_kind),
    externalId: String(row.external_id),
    boxdUrl: String(row.boxd_url),
    uiUrl: String(row.ui_url),
    state: String(row.state) as BoxState,
    image: String(row.image),
    createdAt: String(row.created_at),
    lastSeenAt: row.last_seen_at === null ? undefined : String(row.last_seen_at),
    usageCursor: Number(row.usage_cursor ?? 0),
  };
}

/** A hand-edited JSON column is a repairable mistake, not a reason to refuse to start. */
function parseJson(text: string | null | undefined, fallback: unknown): unknown {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
