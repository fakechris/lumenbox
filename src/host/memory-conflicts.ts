/**
 * Knowledge that disagrees across layers, made visible (INV-1732, docs/98 §7).
 *
 * About the organisation, a verified organisation item (L1) outranks what a box's agents learned
 * together (L2), which outranks what one agent learned for itself (L3). That order is a rule for
 * the reader, not a licence to merge: when two items disagree, the prompt shows both, dated, with
 * their sources, under one heading that says they disagree. Nothing is chosen silently.
 *
 * - **Who notices.** The memory maintenance pass (memory-maintenance.ts) is the one place a model
 *   reads an agent's memories beside the box's and the organisation's, and it is the one that names
 *   a pair (`conflict`). Nothing here guesses at meaning; a pair is recorded only when the pass
 *   named both ids and the code found both live.
 * - **What is kept.** One line per pair in `~/.agentbox/memory-conflicts.jsonl`: the two items by
 *   layer and version, who noticed, why, and when. No text: the text is read from the stores at
 *   render time, so a pair is shown only to a reader who may read both items (the stores' own
 *   admission, memory-scope.ts), and a pair whose item was retracted, superseded or expired simply
 *   stops being shown. There is no "resolve" verb because resolving is correcting one of the items.
 * - **Supersession is proposed, never applied, on L1.** When the pass says the agent's newer line
 *   should replace an organisation item, the line is *promoted* (org-promotion.ts `propose`, the one
 *   path into L1, docs/98 §5 rule 2) with `supersedes` naming the old item and the old item's owner
 *   as owner. It waits in the same organisation review as every promotion, which shows what it
 *   replaces; a held line is read by nobody and supersedes nothing until a person approves it
 *   (org-knowledge.ts `live`). The pass never writes a retraction or a live line into L1.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { appendLineDurably, type LedgerKind } from "./jsonl.ts";
import { dedupe, type MemoryRecord } from "./memory.ts";
import { versionOf } from "./memory-admin.ts";
import type { MaintenancePlan } from "./memory-maintenance.ts";
import type { OrgKnowledge, OrgKnowledgeItem } from "./org-knowledge.ts";
import { propose, type PromotionRequest } from "./org-promotion.ts";

export const LEDGER_KIND: LedgerKind = "record";

/** The ledger's file name under the installation's home. */
export const MEMORY_CONFLICTS_FILE = "memory-conflicts.jsonl";

/** How much of the prompt disagreeing pairs may take; the rest are counted. */
export const CONFLICT_CHAR_BUDGET = 1_200;

/** L1 organisation, L2 box, L3 agent (docs/98 §3). */
export type KnowledgeLayer = "org" | "box" | "agent";

/** The order docs/98 §7 gives, about the organisation: verified L1 > L2 > L3. */
export const LAYER_RANK: Readonly<Record<KnowledgeLayer, number>> = { org: 3, box: 2, agent: 1 };

const LAYER_NAME: Readonly<Record<KnowledgeLayer, string>> = { org: "Organisation (L1)", box: "Your box (L2)", agent: "Your own memory (L3)" };

/** One side of a pair: an item by its layer and version. An agent's own record names its holder, since only that agent reads it. */
export interface ConflictSide {
  layer: KnowledgeLayer;
  version: string;
  holder?: string;
}

/** One recorded disagreement. */
export interface ConflictLine {
  at: string;
  sides: [ConflictSide, ConflictSide];
  /** The agent whose maintenance pass named the pair. */
  by: string;
  reason: string;
  /** The version of a held organisation item proposed to replace the L1 side, waiting for its owner. */
  proposal?: string;
}

/** What a reader may read now, each store already admitted for this reader: the stores' own checks, not this module's. */
export interface ReadableKnowledge {
  agentId: string;
  /** The agent's own records, recallable. */
  agent: readonly MemoryRecord[];
  /** The box's shared records this reader is admitted to, recallable. */
  box: readonly MemoryRecord[];
  /** The organisation items recalled for this reader: admitted, `recall`, verified and in review. */
  org: readonly OrgKnowledgeItem[];
}

const pairKey = (sides: readonly ConflictSide[]): string => sides.map(side => `${side.layer}:${side.version}`).sort().join(" ");

function readable(raw: unknown): raw is ConflictLine {
  const line = raw as Partial<ConflictLine> | null;
  const side = (value: unknown) => {
    const s = value as Partial<ConflictSide> | null;
    return s !== null && typeof s === "object" && (s.layer === "org" || s.layer === "box" || s.layer === "agent") && typeof s.version === "string";
  };
  return line !== null && typeof line === "object" && typeof line.at === "string" && Array.isArray(line.sides) && line.sides.length === 2 && line.sides.every(side) && typeof line.by === "string";
}

/** Why a pair cannot be recorded, or undefined when it can. */
export function validatePair(sides: readonly ConflictSide[]): string | undefined {
  if (sides.length !== 2) return "A disagreement is between exactly two items.";
  const [a, b] = sides as [ConflictSide, ConflictSide];
  if (a.layer === b.layer) return "A disagreement recorded here is across layers; two lines of one layer are corrected in that layer.";
  if ([a, b].some(side => side.layer === "agent" && (side.holder === undefined || side.holder === ""))) return "An agent's own record names the agent that holds it.";
  return undefined;
}

const day = (iso: string | undefined): string => (iso === undefined ? "undated" : iso.slice(0, 10));
const quote = (text: string): string => `"${text.replace(/\s+/g, " ").trim()}"`;

/** One side as the prompt shows it: layer, date, source, and the words. */
function renderSide(side: ConflictSide, record: MemoryRecord): string {
  if (side.layer === "org") {
    const item = record as OrgKnowledgeItem;
    const sources = item.evidence?.length ? `; evidence ${item.evidence.slice(0, 3).join(", ")}` : "";
    return `${LAYER_NAME.org}, verified ${day(item.verifiedAt)} by ${item.verifiedBy ?? "unknown"}, owner ${item.owner ?? "unknown"} [org:${side.version}]${sources}: ${quote(item.text)}`;
  }
  const from = record.from?.length ? `; from ${record.from.slice(0, 2).join(", ")}` : "";
  const who = side.layer === "box" && record.via !== undefined ? `, learned by ${record.via}` : "";
  return `${LAYER_NAME[side.layer]}, ${day(record.at)}${who}${from}: ${quote(record.text)}`;
}

export class MemoryConflicts {
  private readonly log: ConflictLine[] = [];

  constructor(private readonly path: string | undefined) {
    if (path === undefined || !existsSync(path)) return;
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      let line: unknown;
      try { line = JSON.parse(raw); } catch { continue; } // a torn final line, left by a crash mid-append
      if (readable(line)) this.log.push(line);
    }
  }

  /** Records a pair, once: a pair already recorded is returned as it was, unless this one brings a proposal it lacked. */
  record(line: ConflictLine): ConflictLine {
    const reason = validatePair(line.sides);
    if (reason !== undefined) throw new Error(reason);
    const key = pairKey(line.sides);
    const known = this.pairs().find(existing => pairKey(existing.sides) === key);
    if (known !== undefined && (line.proposal === undefined || known.proposal === line.proposal)) return known;
    if (this.path !== undefined) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendLineDurably(this.path, JSON.stringify(line));
    }
    this.log.push(line);
    return line;
  }

  /** Every line, as written. */
  lines(): readonly ConflictLine[] {
    return this.log;
  }

  /** One line per pair, the latest for each. */
  pairs(): ConflictLine[] {
    const byKey = new Map<string, ConflictLine>();
    for (const line of this.log) byKey.set(pairKey(line.sides), line);
    return [...byKey.values()];
  }

  /** The prompt section for this reader: each pair it may read both sides of, higher layer first, newest pair first, in its own budget. */
  section(reader: ReadableKnowledge, budget = CONFLICT_CHAR_BUDGET): string | undefined {
    if (this.log.length === 0) return undefined;
    const live: Record<KnowledgeLayer, Map<string, MemoryRecord>> = {
      org: new Map(reader.org.map(item => [versionOf(item), item])),
      box: new Map(dedupe(reader.box).map(record => [versionOf(record), record])),
      agent: new Map(dedupe(reader.agent).map(record => [versionOf(record), record])),
    };
    const find = (side: ConflictSide) => (side.layer === "agent" && side.holder !== reader.agentId ? undefined : live[side.layer].get(side.version));
    const shown = this.pairs()
      .sort((a, b) => b.at.localeCompare(a.at))
      .flatMap(line => {
        const [high, low] = [...line.sides].sort((a, b) => LAYER_RANK[b.layer] - LAYER_RANK[a.layer]) as [ConflictSide, ConflictSide];
        const higher = find(high);
        const lower = find(low);
        if (higher === undefined || lower === undefined) return [];
        const waiting = line.proposal !== undefined && high.layer === "org" ? ` A replacement from your memory is waiting for ${(higher as OrgKnowledgeItem).owner ?? "the owner"}'s review; until it is approved the organisation item stands.` : "";
        return [[
          `- ${renderSide(high, higher)}`,
          `  disagrees with ${renderSide(low, lower)}`,
          `  Outranks: ${LAYER_NAME[high.layer]}. Noticed ${day(line.at)}${line.reason !== "" ? `: ${line.reason}` : ""}.${waiting}`,
        ].join("\n")];
      });
    if (shown.length === 0) return undefined;
    const kept: string[] = [];
    let used = 0;
    for (const entry of shown) {
      if (kept.length > 0 && used + entry.length + 1 > budget) break; // the newest pair is always shown whole
      kept.push(entry);
      used += entry.length + 1;
    }
    const omitted = shown.length - kept.length;
    return [
      "## These disagree",
      "",
      "Each pair below says different things about the same subject. Neither has been merged or chosen for you. About the organisation, a verified organisation item outranks your box's memory, and your box's outranks your own: act on the higher one, and when the lower one may be newer, say so to the person rather than choosing silently. To correct your own line, Forget it.",
      "",
      ...kept,
      ...(omitted > 0 ? [`${omitted} more disagreeing pairs are not shown.`] : []),
    ].join("\n");
  }
}

/**
 * What a maintenance pass found across layers, written: each pair recorded, each supersession
 * appended to the organisation's ledger held, for its owner. Returns how many of each were written.
 * A proposal the ledger refuses (a personal installation has no L1) is logged and its pair kept.
 */
export function recordAcrossLayers(
  plan: Pick<MaintenancePlan, "conflicts" | "supersessions">,
  deps: { agentId: string; conflicts: Pick<MemoryConflicts, "record">; orgKnowledge?: Pick<OrgKnowledge, "append" | "lines">; now: Date; log: (line: string) => void }
): { pairs: number; proposals: number } {
  const at = deps.now.toISOString();
  let pairs = 0;
  let proposals = 0;
  for (const found of plan.conflicts) {
    deps.conflicts.record({ at, sides: found.sides, by: deps.agentId, reason: found.proposal.reason });
    pairs += 1;
  }
  for (const found of plan.supersessions) {
    let proposal: string | undefined;
    const replacing = found.replacing as OrgKnowledgeItem;
    if (deps.orgKnowledge !== undefined) {
      const result = propose(deps.orgKnowledge, {
        source: { kind: "memory", record: found.record, holder: deps.agentId },
        scope: (replacing.scope ?? "org") as PromotionRequest["scope"],
        owner: replacing.owner ?? "",
        via: deps.agentId,
        supersedes: versionOf(replacing),
      }, deps.now);
      if (result.ok) { proposal = result.version; proposals += 1; }
      else deps.log(`maintenance could not propose replacing org:${versionOf(replacing)}: ${result.why}`);
    }
    const sides: [ConflictSide, ConflictSide] = [{ layer: "agent", version: versionOf(found.record), holder: deps.agentId }, { layer: "org", version: versionOf(found.replacing) }];
    deps.conflicts.record({ at, sides, by: deps.agentId, reason: found.proposal.reason, ...(proposal !== undefined ? { proposal } : {}) });
    pairs += 1;
  }
  return { pairs, proposals };
}
