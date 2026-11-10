import type { Lane } from "../agents/bus.ts";

export interface PromptOptions {
      conversation?: string;
      taskBinding?: import("./execution-binding.ts").TaskBinding;
      steerable?: boolean;
      lane?: Lane;
      synthetic?: boolean; origin?: string; // the host part that wrote it (INV-1571); see InboundMessage.origin
      /** False when a room message named nobody (INV-775); see `InboundMessage.addressed`. */
      addressed?: boolean;
      /** The message's id from the door it came through (INV-613); see `AgentBus.sendFromUser`. */
      messageId?: string;
      /** A routine's declared tools (INV-691); see `InboundMessage.toolScope`. */
      toolScope?: readonly string[];
}
