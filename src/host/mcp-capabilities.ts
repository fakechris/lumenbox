/**
 * The capability ledger: what each MCP server offered, hashed, by version, over time (INV-813).
 *
 * A server started through `npx` is whatever upstream published; a pinned version holds it
 * still, but the pin is in code and the tools are on the wire, and the two drift the day
 * somebody overrides the pin or the server lies about itself. The prompt fingerprint (INV-782)
 * says the tools changed; this says when, from which version, and what the list was — so a
 * changed hash can be read against a release, and rolled back by changing one pin.
 *
 * One line per change, never one per start: a server that comes up with the same tools it had
 * is not news. The hash is over the normalised tool set — name, description, schema — in name
 * order, so a server that lists in a different order has not changed.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendLine } from "./jsonl.ts";
import type { McpTool } from "./mcp.ts";

export interface CapabilityRecord {
  at: string;
  server: string;
  package?: string;
  version?: string;
  hash: string;
  tools: string[];
  /** The hash this replaced, when there was one — the line to diff against. */
  previous?: string;
}

/** Sixteen hex characters over the normalised tool set. */
export function capabilityHash(tools: readonly McpTool[]): string {
  const normalised = [...tools]
    .map(tool => ({ name: tool.name, description: tool.description, inputSchema: canonical(tool.inputSchema) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(normalised)).digest("hex").slice(0, 16);
}

/** JSON with object keys in order, so two schemas that differ only in key order hash alike. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map(key => [key, canonical((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

export class CapabilityLedger {
  constructor(
    private readonly path: string,
    private readonly log: (line: string) => void = () => {}
  ) {}

  /** Every record, oldest first; a torn last line is skipped like every ledger here. */
  list(): CapabilityRecord[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out: CapabilityRecord[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as CapabilityRecord);
      } catch {
        // torn or hand-edited: skipped, never fatal
      }
    }
    return out;
  }

  /** The last thing recorded for a server. */
  latest(server: string): CapabilityRecord | undefined {
    const all = this.list();
    for (let i = all.length - 1; i >= 0; i -= 1) if (all[i]!.server === server) return all[i];
    return undefined;
  }

  /**
   * Records a server's tool set if it differs from the last one recorded; says whether it did.
   * The first sighting is a change from nothing and is recorded; the same hash again is not.
   */
  record(
    server: string,
    tools: readonly McpTool[],
    pinned: { package: string; version: string } | undefined,
    now: Date = new Date()
  ): { changed: boolean; hash: string; previous?: string } {
    const hash = capabilityHash(tools);
    const last = this.latest(server);
    if (last !== undefined && last.hash === hash) return { changed: false, hash };
    const record: CapabilityRecord = {
      at: now.toISOString(),
      server,
      ...(pinned !== undefined ? { package: pinned.package, version: pinned.version } : {}),
      hash,
      tools: tools.map(tool => tool.name).sort(),
      ...(last !== undefined ? { previous: last.hash } : {}),
    };
    appendLine(this.path, JSON.stringify(record));
    const where = pinned !== undefined ? ` (${pinned.package}@${pinned.version})` : "";
    this.log(
      last === undefined
        ? `mcp ${server}: capabilities recorded, ${tools.length} tool(s), hash ${hash}${where}`
        : `mcp ${server}: capabilities CHANGED ${last.hash} → ${hash}${where}: ` +
            `${describeDiff(last.tools, record.tools)} — see ${this.path}`
    );
    return { changed: true, hash, ...(last !== undefined ? { previous: last.hash } : {}) };
  }
}

function describeDiff(before: readonly string[], after: readonly string[]): string {
  const added = after.filter(name => !before.includes(name));
  const removed = before.filter(name => !after.includes(name));
  const parts: string[] = [];
  if (added.length > 0) parts.push(`added ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`removed ${removed.join(", ")}`);
  if (parts.length === 0) parts.push("same names, a description or schema changed");
  return parts.join("; ");
}
