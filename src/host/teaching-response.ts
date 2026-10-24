import type Anthropic from "@anthropic-ai/sdk";

/** Reasoning blocks are private protocol metadata, never draft contents. */
export function teachingResponseText(response: Pick<Anthropic.Message, "stop_reason" | "content">): string {
  if (response.stop_reason !== "end_turn") {
    throw new Error(`Teaching generation incomplete (stop_reason=${response.stop_reason ?? "missing"})`);
  }
  if (response.content.some(block => !["text", "thinking", "redacted_thinking"].includes(block.type))) {
    throw new Error("Teaching generation returned an unsupported action block");
  }
  const text = response.content.filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map(block => block.text).join("\n").trim();
  if (!text) throw new Error("Teaching generation returned no proposal text");
  return text;
}
