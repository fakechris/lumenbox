import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";

export interface DirectoryDepartment { vendorId: string; name: string; parentVendorId: string | null }
export interface DirectoryPerson { vendorSubject: string; name: string; departmentVendorIds: string[]; title?: string }
export interface DirectorySnapshot { departments: DirectoryDepartment[]; people: DirectoryPerson[] }
export interface DirectorySource { channelId: string; incarnation: number; tenantKey: string }
export interface DirectoryRecord { source: DirectorySource; snapshot?: DirectorySnapshot; syncedAt?: string; failedAt?: string }
export const DIRECTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export function directorySource(channelId: string, incarnation: number, clientId: string, domain: string): DirectorySource {
  return { channelId, incarnation, tenantKey: createHash("sha256").update(JSON.stringify([clientId, domain])).digest("hex") };
}
export function departmentQuotaKey(source: DirectorySource, department: string): string {
  return JSON.stringify([source.channelId, source.incarnation, source.tenantKey, department]);
}
function sameSource(a: DirectorySource, b: DirectorySource): boolean { return departmentQuotaKey(a, "") === departmentQuotaKey(b, ""); }

function validSnapshot(value: unknown): value is DirectorySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as DirectorySnapshot;
  if (!Array.isArray(snapshot.departments) || !Array.isArray(snapshot.people)) return false;
  const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  return snapshot.departments.every(row => row && nonempty(row.vendorId) && nonempty(row.name) && (row.parentVendorId === null || nonempty(row.parentVendorId)))
    && new Set(snapshot.departments.map(row => row.vendorId)).size === snapshot.departments.length
    && snapshot.people.every(row => row && nonempty(row.vendorSubject) && nonempty(row.name) && Array.isArray(row.departmentVendorIds) && row.departmentVendorIds.length > 0 && row.departmentVendorIds.every(nonempty))
    && new Set(snapshot.people.map(row => row.vendorSubject)).size === snapshot.people.length;
}

/** Directory rows never create or merge Principals. Only authenticated roster links are consulted. */
export class Directories {
  private readonly syncing = new Set<string>();
  constructor(private readonly path = join(agentboxHome(), "directory.json")) {}
  private read(): Record<string, DirectoryRecord> {
    if (!existsSync(this.path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Repair directory.json before allocating boxes");
    for (const [id, value] of Object.entries(parsed)) {
      const record = value as DirectoryRecord;
      if (!record || !record.source || record.source.channelId !== id || !Number.isSafeInteger(record.source.incarnation)
        || typeof record.source.tenantKey !== "string" || (record.snapshot !== undefined && !validSnapshot(record.snapshot))) {
        throw new Error("Repair directory.json before allocating boxes");
      }
    }
    return parsed as Record<string, DirectoryRecord>;
  }
  of(channelId: string): DirectoryRecord | undefined { const records = this.read(); return Object.hasOwn(records, channelId) ? records[channelId] : undefined; }
  private save(record: DirectoryRecord): void {
    const records = this.read();
    Object.defineProperty(records, record.source.channelId, { value: record, enumerable: true, writable: true, configurable: true });
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(records), { mode: 0o600 });
    renameSync(temp, this.path);
  }
  async sync(source: DirectorySource, fetchSnapshot: () => Promise<DirectorySnapshot>, current: () => DirectorySource | undefined = () => source): Promise<DirectoryRecord> {
    if (this.syncing.has(source.channelId)) throw new Error("Directory sync already running");
    this.syncing.add(source.channelId);
    try {
      const snapshot = await fetchSnapshot();
      if (!validSnapshot(snapshot)) throw new Error("Incomplete directory snapshot");
      const live = current();
      if (!live || !sameSource(source, live)) throw new Error("Directory source changed during sync");
      const record = { source, snapshot, syncedAt: new Date().toISOString() };
      this.save(record);
      return record;
    } catch {
      const live = current();
      if (live && sameSource(source, live)) {
        const previous = this.of(source.channelId);
        this.save({ ...(previous && sameSource(source, previous.source) ? previous : { source }), failedAt: new Date().toISOString() });
      }
      // Provider errors can echo URLs with credentials. Keep them out of logs and API responses.
      throw new Error("Directory sync failed; check directory permission and retry. Previous complete snapshot retained.");
    } finally { this.syncing.delete(source.channelId); }
  }
  status(source: DirectorySource, now = Date.now()): "not-synced" | "changed" | "failed" | "stale" | "ready" {
    const record = this.of(source.channelId);
    if (!record) return "not-synced";
    if (!sameSource(source, record.source)) return "changed";
    if (record.failedAt) return "failed";
    const at = Date.parse(record.syncedAt ?? "");
    if (!record.snapshot || !Number.isFinite(at) || now - at > DIRECTORY_MAX_AGE_MS || at > now + 60_000) return "stale";
    return "ready";
  }
  /** A synced door is authoritative for new allocations via its identities. Missing/departed/stale fails closed. */
  membership(identities: readonly string[], sources: readonly DirectorySource[], now = Date.now()): { eligible: boolean; departmentKeys: string[] } {
    const keys = new Set<string>();
    for (const identity of identities) {
      const colon = identity.indexOf(":");
      if (colon < 1) continue;
      const channelId = identity.slice(0, colon);
      const record = this.of(channelId);
      if (!record) continue; // Directory policy is opt-in, by syncing this door.
      const source = sources.find(item => item.channelId === channelId);
      if (!source || this.status(source, now) !== "ready") return { eligible: false, departmentKeys: [] };
      const person = record.snapshot!.people.find(item => item.vendorSubject === identity.slice(colon + 1));
      if (!person) return { eligible: false, departmentKeys: [] };
      for (const id of person.departmentVendorIds) keys.add(departmentQuotaKey(source, id));
    }
    return { eligible: true, departmentKeys: [...keys].sort() };
  }
}
