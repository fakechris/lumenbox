/**
 * Provider conformance probes: does this endpoint behave like the wire the turn
 * engine assumes?
 *
 * "Compatible" endpoints differ in everything the happy path does not touch — tool
 * results across rounds, parallel calls, streaming termination, image blocks, cache
 * markers — and each difference surfaces mid-task as a confusing turn failure rather
 * than at configuration time as a named gap. These probes are the named gaps: one
 * cheap live request per behaviour the engine relies on, through the same client a
 * turn uses, so what passes here is what runs there.
 *
 * Three honest outcomes beyond ok. **failed** is a wire problem — the request errored
 * or the shape came back wrong. **degraded** is a model choice the engine tolerates
 * but a buyer should know about (calls tools one at a time, refuses images). And
 * **skipped** is a capability the profile already declares off — probing it would
 * test the gate, not the endpoint.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { createClient, type ProviderProfile } from "./provider.ts";

export interface ProbeResult {
  name: string;
  status: "ok" | "degraded" | "failed" | "skipped";
  detail: string;
  ms: number;
}

/** 1x1 transparent PNG — enough to prove an image block travels. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const CLOCK: Anthropic.Tool = {
  name: "read_clock",
  description: "Reads the wall clock. Call it whenever the current time is needed.",
  input_schema: { type: "object", properties: { zone: { type: "string" } } },
};

const DIE: Anthropic.Tool = {
  name: "roll_die",
  description: "Rolls a six-sided die. Call it whenever a random number is needed.",
  input_schema: { type: "object", properties: {} },
};

interface Probe {
  name: string;
  run: (
    client: Anthropic,
    profile: ProviderProfile
  ) => Promise<Omit<ProbeResult, "name" | "ms">>;
}

const ok = (detail: string) => ({ status: "ok" as const, detail });
const degraded = (detail: string) => ({ status: "degraded" as const, detail });
const failed = (detail: string) => ({ status: "failed" as const, detail });

function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map(block => block.text)
    .join("\n");
}

function toolUses(response: Anthropic.Message): Anthropic.ToolUseBlock[] {
  return response.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
}

const PROBES: readonly Probe[] = [
  {
    name: "echo",
    run: async (client, profile) => {
      const response = await client.messages.create({
        model: profile.model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      });
      return textOf(response).trim() === ""
        ? failed("no text came back")
        : ok(`"${textOf(response).trim().slice(0, 20)}"`);
    },
  },
  {
    // Two attempts before judging: a model may answer the time from its head once,
    // and that is flakiness worth naming, not a broken wire. failed is reserved for
    // the wire — an error, a wrong shape — which no retry changes.
    name: "tool-call",
    run: async (client, profile) => {
      let lastStop: string | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await client.messages.create({
          model: profile.model,
          max_tokens: 256,
          tools: [CLOCK],
          messages: [
            {
              role: "user",
              content:
                "What time is it right now? You cannot know without the tool — call read_clock.",
            },
          ],
        });
        const call = toolUses(response)[0];
        if (call === undefined) {
          lastStop = response.stop_reason;
          continue;
        }
        if (call.name !== "read_clock") return failed(`called "${call.name}" instead`);
        if (typeof call.input !== "object" || call.input === null) {
          return failed("tool input is not an object");
        }
        return ok(
          `called read_clock${attempt > 0 ? " (second attempt)" : ""}, id ${call.id.slice(0, 12)}…`
        );
      }
      return degraded(`declined the tool twice (stop: ${lastStop}) — flaky tool calling`);
    },
  },
  {
    // The one that catches wire-translation bugs: a tool_result travelling back. The
    // history is hand-written rather than model-produced, so the probe tests the wire
    // and not whether the model felt like calling a tool this time.
    name: "tool-round-trip",
    run: async (client, profile) => {
      const response = await client.messages.create({
        model: profile.model,
        max_tokens: 256,
        tools: [CLOCK],
        messages: [
          { role: "user", content: "What time is it right now? Use the tool, then tell me." },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_probe_1", name: "read_clock", input: {} },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_probe_1", content: "14:05" }],
          },
        ],
      });
      const answer = textOf(response);
      return /14[::]05|2[::]05/.test(answer)
        ? ok("the result came back in the answer")
        : degraded(`answered without the given time: "${answer.trim().slice(0, 60)}"`);
    },
  },
  {
    name: "parallel-tools",
    run: async (client, profile) => {
      const response = await client.messages.create({
        model: profile.model,
        max_tokens: 512,
        tools: [CLOCK, DIE],
        messages: [
          {
            role: "user",
            content:
              "In this single response, read the clock AND roll the die — call both tools before saying anything.",
          },
        ],
      });
      const names = toolUses(response).map(call => call.name);
      if (names.length >= 2) return ok(`both in one response (${names.join(", ")})`);
      if (names.length === 1) return degraded(`one at a time (${names[0]})`);
      return failed(`no tool_use (stop: ${response.stop_reason})`);
    },
  },
  {
    name: "streaming",
    run: async (client, profile) => {
      const stream = client.messages.stream({
        model: profile.model,
        max_tokens: 64,
        messages: [{ role: "user", content: "Count from 1 to 10, comma separated." }],
      });
      let deltas = 0;
      stream.on("text", () => {
        deltas += 1;
      });
      const final = await stream.finalMessage();
      if (textOf(final).trim() === "") return failed("stream ended with no text");
      if (deltas === 0) return degraded("answer arrived, but in one piece — no deltas");
      return ok(`${deltas} deltas, clean stop`);
    },
  },
  {
    name: "vision",
    run: async (client, profile) => {
      if (!profile.vision) return { status: "skipped", detail: "profile declares no vision" };
      const response = await client.messages.create({
        model: profile.model,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: PIXEL },
              },
              { type: "text", text: "Did an image arrive with this message? Answer yes or no." },
            ],
          },
        ],
      });
      const answer = textOf(response).toLowerCase();
      if (answer.includes("yes") || answer.includes("是")) return ok("sees the image block");
      return degraded(`unclear answer: "${answer.trim().slice(0, 40)}"`);
    },
  },
  {
    name: "long-output",
    run: async (client, profile) => {
      const response = await client.messages.create({
        model: profile.model,
        max_tokens: Math.min(2048, profile.maxTokens),
        messages: [
          { role: "user", content: "Count from 1 to 200, comma separated, nothing else." },
        ],
      });
      const text = textOf(response);
      if (text.includes("199")) return ok(`${text.length} chars, stop: ${response.stop_reason}`);
      if (response.stop_reason === "max_tokens") {
        return degraded(`truncated at ${text.length} chars by max_tokens`);
      }
      return degraded(`stopped early (${response.stop_reason}) after ${text.length} chars`);
    },
  },
  {
    name: "unicode",
    run: async (client, profile) => {
      const response = await client.messages.create({
        model: profile.model,
        max_tokens: 64,
        messages: [{ role: "user", content: "请用中文回答:一加一等于几?" }],
      });
      const answer = textOf(response);
      return /[二2两]/.test(answer)
        ? ok("Chinese in, Chinese out")
        : degraded(`unexpected answer: "${answer.trim().slice(0, 40)}"`);
    },
  },
  {
    name: "prompt-caching",
    run: async (client, profile) => {
      if (!profile.promptCaching) {
        return { status: "skipped", detail: "profile declares no caching" };
      }
      const filler = "The quick brown fox jumps over the lazy dog. ".repeat(120);
      const response = await client.messages.create({
        model: profile.model,
        max_tokens: 16,
        system: [
          { type: "text", text: filler, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      });
      const usage = response.usage as { cache_creation_input_tokens?: number | null };
      return typeof usage.cache_creation_input_tokens === "number"
        ? ok(`cache markers accepted and metered (${usage.cache_creation_input_tokens} written)`)
        : degraded("cache markers accepted but not metered in usage");
    },
  },
];

/** Every probe against one profile, in order, each timed and never throwing. */
export async function runConformance(
  profile: ProviderProfile,
  onResult?: (result: ProbeResult) => void
): Promise<ProbeResult[]> {
  const client = createClient(profile);
  const results: ProbeResult[] = [];
  for (const probe of PROBES) {
    const started = Date.now();
    let outcome: Omit<ProbeResult, "name" | "ms">;
    try {
      outcome = await probe.run(client, profile);
    } catch (error) {
      outcome = failed(error instanceof Error ? error.message : String(error));
    }
    const result: ProbeResult = { name: probe.name, ms: Date.now() - started, ...outcome };
    results.push(result);
    onResult?.(result);
  }
  return results;
}

export const PROBE_COUNT = PROBES.length;
