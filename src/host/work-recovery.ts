/**
 * Conservative, explicit recovery of the requests people made before requests were recorded.
 *
 * It never queues work, never wakes a model and never attributes a turn's tool steps. Who made a
 * request is `openingProvenance`'s call (request-provenance.ts, INV-1808): a request is restored
 * when ingress evidence says a person sent it, and an entry that only carries the old stamp is
 * listed as unknown until a named person confirms it.
 */
import { createHash } from "node:crypto";
import type { AgentRegistry } from "../agents/registry.ts";
import { type IngressEvidence, NO_EVIDENCE, type OpeningEntry, openingProvenance } from "./request-provenance.ts";
import type { TaskStore } from "./tasks.ts";
import { redactText } from "./secret-redaction.ts";

export interface RecoveryOptions {
  /** Record what is found. Without it nothing is written. */
  apply?: boolean;
  evidence?: IngressEvidence;
  /** Unknown entries a person vouches for, by the `source` the preview printed, and who is vouching. */
  confirm?: { sources: readonly string[]; by: string };
}

interface Found {
  source: string;
  conversation: string;
  epoch: number;
  turnId?: string;
  text: string;
  sourceIds: string[];
}
export interface RecoveredRequest extends Found {
  evidence: "door" | "heard" | "confirmed";
  principal?: string;
  channel?: string;
  chatKey?: string;
  identity?: string;
  confirmedBy?: string;
  confirmedAt?: string;
  taskId?: string;
}
export interface UnknownRequest extends Found {
  why: string;
  /** What the text reads like, for the person deciding. Never the reason it was held back. */
  reads: string;
}

export function recoverUserRequests(registry: AgentRegistry, tasks: TaskStore, agentId: string, options: RecoveryOptions = {}) {
  const apply = options.apply === true, evidence = options.evidence ?? NO_EVIDENCE;
  const confirmed = new Set(options.confirm?.sources ?? []);
  if (confirmed.size > 0 && !options.confirm?.by.trim()) throw new Error("Confirming an unverified request needs the name of the person confirming it");
  const requests: RecoveredRequest[] = [], unknown: UnknownRequest[] = [], gaps: string[] = [];
  const known = new Set(
    tasks
      .list()
      .flatMap(task => [task.sourceMessageId, ...(task.workRoot?.requests?.map(row => row.id) ?? [])])
      .filter(Boolean),
  );
  for (const conversation of registry.listConversations(agentId)) {
    if (/^(work-|peer-|fork\/|audit-|goalverify-)/.test(conversation.id)) continue;
    const epochs = registry.readContextTranscriptsByEpoch(agentId, conversation.id, { bytes: 32 * 1024 * 1024, entries: 20000 });
    if (epochs.partial) gaps.push(conversation.id);
    for (const epoch of epochs)
      for (const entry of epoch.entries as OpeningEntry[]) {
        const provenance = openingProvenance(agentId, entry, evidence);
        if (provenance.by === "host") continue;
        const text = provenance.text.trim();
        if (text === "") continue;
        const { sourceIds } = provenance;
        const source =
          sourceIds.length === 1
            ? sourceIds[0]!
            : "historical-" +
              createHash("sha256")
                // A turn that cites no message is told apart by when it was written and what it said.
                .update(JSON.stringify([agentId, conversation.id, epoch.epoch, entry.turnId, sourceIds, ...(sourceIds.length === 0 ? [(entry as { at?: string }).at, text] : [])]))
                .digest("hex");
        if (known.has(source)) continue;
        const found: Found = { source, conversation: conversation.id, epoch: epoch.epoch, ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}), text: redactText(text), sourceIds };
        if (provenance.by === "unknown" && !confirmed.has(source)) {
          unknown.push({ ...found, why: provenance.why, reads: provenance.reads });
          continue;
        }
        known.add(source);
        const record: RecoveredRequest =
          provenance.by === "person"
            ? {
                ...found, evidence: provenance.evidence,
                ...(provenance.principal !== undefined ? { principal: provenance.principal } : {}),
                ...(provenance.channel !== undefined ? { channel: provenance.channel, chatKey: provenance.chatKey!, identity: provenance.identity! } : {}),
              }
            : { ...found, evidence: "confirmed", confirmedBy: options.confirm!.by.trim(), confirmedAt: new Date().toISOString() };
        confirmed.delete(source);
        const task = apply ? tasks.workRoots.recover(agentId, record) : undefined;
        requests.push({ ...record, ...(task ? { taskId: task.id } : {}) });
      }
  }
  // A confirmation that matched nothing is said, not dropped: the person named something that is not there.
  return { applied: apply, requests, unknown, gaps, unmatched: [...confirmed] };
}

const USAGE = [
  "recover-work <agent> [--apply] [--confirm <source>[,<source>…] --by <person>]",
  "  Lists requests people made before requests were recorded. A request is restored only when the door's",
  "  ledger or the heard record shows a person sent it; the rest are listed under `unknown`.",
  "  --apply    records the verified ones as historical requests. Nothing is queued or run.",
  "  --confirm  also restores the named unknown entries, on the word of the person named by --by.",
].join("\n");

export async function recoverWorkCommand(args: string[], io: { out: (text: string) => void; err: (text: string) => void }) {
  const { AgentRegistry } = await import("../agents/registry.ts"),
    { TaskStore } = await import("./tasks.ts");
  const flagValue = (flag: string) => { const at = args.indexOf(flag); return at === -1 ? undefined : args[at + 1]; };
  const sources = flagValue("--confirm")?.split(",").map(item => item.trim()).filter(Boolean) ?? [], by = flagValue("--by")?.trim() ?? "";
  if (!args[0] || args[0].startsWith("--") || (args.includes("--confirm") && (sources.length === 0 || by === ""))) {
    io.err(USAGE);
    return 1;
  }
  const { agentboxHome } = await import("../config.ts"), { join } = await import("node:path");
  const { Messages, messagesPath } = await import("../channels/messages.ts"), { HeardRecord } = await import("../agents/heard-record.ts");
  const doors = new Map(new Messages(messagesPath(agentboxHome())).list().map(row => [row.id, row])), heard = new HeardRecord(join(agentboxHome(), "heard"));
  const registry = new AgentRegistry(),
    agent = registry.resolve(args[0]);
  const result = recoverUserRequests(registry, new TaskStore(), agent.id, {
    apply: args.includes("--apply"),
    evidence: { door: id => doors.get(id), heard: (agentId, id) => heard.get(agentId, id) },
    ...(sources.length > 0 ? { confirm: { sources, by } } : {}),
  });
  io.out(JSON.stringify(result, null, 2));
  return result.unmatched.length > 0 ? 1 : 0;
}
