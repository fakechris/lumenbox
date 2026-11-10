/** Registry-owned transcript catalog. Source identities survive epoch flattening and file relocation. */
import { createHash } from "node:crypto";
import type { AgentRegistry } from "../agents/registry.ts";
import type { ExecutionStepRecord } from "../host/execution-records.ts";
import type { TranscriptReadBudget } from "../agents/transcript-bounded.ts";
import { toDisplayEntries } from "./transcript.ts";

export const sourceDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface ExecutionContent {
  call?: { hash: string; epoch: number; name: string; detail: string; input: unknown };
  result?: { hash: string; epoch: number; text: string; isError: boolean };
}

/** Reads only the already-authorized execution's agent/conversation. No paths accepted from a client. */
export function executionContent(registry: Pick<AgentRegistry, "readContextTranscriptsByEpoch">,
  scope: Pick<ExecutionStepRecord, "agentId" | "conversation">, budget?: TranscriptReadBudget): { values: Map<string, ExecutionContent>; partial: boolean } {
  const values = new Map<string, ExecutionContent>();
  try {
    for (const { epoch, entries } of registry.readContextTranscriptsByEpoch(scope.agentId, scope.conversation, budget)) {
      for (const raw of entries) {
        const entry = raw as { turnId?: string; executionId?: string; kind?: string; blocks?: Record<string, unknown>[] };
        if (!entry.turnId || !Array.isArray(entry.blocks)) continue;
        const recordHash = sourceDigest([scope.agentId, scope.conversation, epoch, raw]);
        for (const block of entry.blocks) {
          const id = entry.kind === "blocks" && block.type === "tool_use" ? block.id
            : entry.kind === "results" && block.type === "tool_result" ? block.tool_use_id : undefined;
          if (typeof id !== "string") continue;
          const logical = JSON.stringify([entry.turnId, id]);
          const exact = JSON.stringify([entry.turnId, id, entry.executionId ?? ""]);
          const logicalValue = values.get(logical) ?? {};
          const value = values.get(exact) ?? {};
          const hash = sourceDigest([recordHash, block]);
          if (entry.kind === "blocks") {
            const shown = toDisplayEntries([{ ...entry, blocks: [block] }], []).find(e => e.kind === "tools");
            const tool = shown?.kind === "tools" ? shown.tools[0] : undefined;
            if (tool) {
              value.call = { hash, epoch, name: tool.name, detail: tool.detail, input: block.input };
              logicalValue.call = value.call;
              values.set("hash:" + hash, { call: value.call });
            }
          } else {
            const text = typeof block.content === "string" ? block.content : Array.isArray(block.content)
              ? block.content.filter(p => p?.type === "text").map(p => p.text ?? "").join("\n") : "";
            value.result = { hash, epoch, text, isError: block.is_error === true };
            values.set("hash:" + hash, { result: value.result });
          }
          values.set(exact, value);
          values.set(logical, logicalValue);
        }
      }
    }
    return { values, partial: false };
  } catch { return { values, partial: true }; }
}

export function contentFor(values: Map<string, ExecutionContent>, step: Pick<ExecutionStepRecord, "id" | "executionId" | "toolUseId">): ExecutionContent {
  const exact = values.get(JSON.stringify([step.id, step.toolUseId, step.executionId]));
  // A resumed call can reuse its original tool_use block; its result still must belong to this invocation.
  return { call: exact?.call ?? values.get(JSON.stringify([step.id, step.toolUseId]))?.call, result: exact?.result };
}
