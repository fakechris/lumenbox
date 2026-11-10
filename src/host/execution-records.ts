/** Typed, text-free observations in the existing turn record, not a second execution engine. */
import type { TaskBinding } from "./execution-binding.ts";

export interface ExecutionStepRecord {
  event: "step";
  id: string;
  recordId: string;
  executionId: string;
  attempt: number;
  agentId: string;
  boxId: string;
  conversation: string;
  contextEpoch: number;
  workId: string;
  taskBinding?: TaskBinding;
  toolUseId: string;
  tool: string;
  phase: "start" | "end";
  isError?: boolean;
  outcome?: import("../protocol/index.ts").Outcome | "waiting";
  gate?: import("./gate-verdict.ts").GateVerdict;
  at: string;
}

export interface ExecutionSelectionRecord {
  event: "selection";
  id: string;
  recordId: string;
  executionId: string;
  attempt: number;
  taskBinding: TaskBinding;
  toolUseId: string;
  at: string;
}

export interface ExecutionMaintenanceRecord {
  event: "maintenance";
  id: string; recordId: string; executionId: string; attempt: number; workId: string;
  agentId: string; boxId: string; conversation: string; contextEpoch: number;
  taskBinding?: TaskBinding;
  kind: "compacted" | "retrying";
  at: string;
  covers?: number; summarised?: boolean; delayMs?: number; retryAttempt?: number;
}
