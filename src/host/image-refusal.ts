/**
 * An image the model refused is not a reason to lose the turn (INV-1353).
 *
 * MiniMax answered a request carrying a WebP screenshot with 400 "invalid image content: decode
 * image config: image: unknown format (2013)", and the turn died on it: the person got nothing,
 * four times out of four in the INV-1340 eval. A provider refusing one attachment is the same
 * class of event as a provider refusing a request for size (turn.ts, `shedForRetry`): recoverable,
 * by taking the attachment out and saying so where it was, then asking again.
 *
 * Two smaller things live here too. `sniffImage` reads the magic bytes, so `read_file` attaches an
 * image only when the bytes are one — a text file called `a.png` used to go up as an image and be
 * refused the same way. And the phrase table is what the provider actually said, not a guess at
 * "image": a broad match would turn a real bug into a silent retry.
 */

import type Anthropic from "@anthropic-ai/sdk";

/** What the provider says when it cannot read an image it was sent. Lower-case substrings. */
const REFUSAL_PHRASES = [
  "invalid image content",
  "image: unknown format",
  "unknown image format",
  "unsupported image",
  "could not process image",
  "image could not be decoded",
  "invalid base64 image",
  "invalid image data",
  "image format is not supported",
  "could not decode image",
];

/** The provider's reason when an error is an image refusal, or undefined when it is something else. */
export function imageRefusalOf(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (!REFUSAL_PHRASES.some(phrase => lower.includes(phrase))) return undefined;
  // The provider's own words, trimmed to the sentence that names the problem.
  const match = /"message"\s*:\s*"([^"]{1,200})"/.exec(message);
  return (match?.[1] ?? message).slice(0, 200);
}

/** What stands where a refused image was: the model learns there was one, and why it is not here. */
export function refusedImageNote(reason: string): string {
  return `[an image was attached here, but the model refused it: ${reason}]`;
}

/**
 * Replaces every image block in the conversation with a note, in place. Returns how many. All of
 * them, not the oldest: the provider did not say which one it could not read, and a retry that
 * keeps one is a retry that may fail the same way.
 */
export function replaceRefusedImages(messages: Anthropic.MessageParam[], reason: string): number {
  let replaced = 0;
  const note = { type: "text" as const, text: refusedImageNote(reason) };
  const swap = (parts: unknown[]): unknown[] =>
    parts.map(part => {
      if ((part as { type?: string }).type !== "image") return part;
      replaced += 1;
      return note;
    });
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    message.content = swap(message.content) as typeof message.content;
    for (const block of message.content) {
      const result = block as { type?: string; content?: unknown };
      if (result.type === "tool_result" && Array.isArray(result.content)) result.content = swap(result.content);
    }
  }
  return replaced;
}

export type SniffedImage = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** The image type the bytes say they are, or undefined when they are not an image this can attach. */
export function sniffImage(base64: string): SniffedImage | undefined {
  const head = Buffer.from(base64.slice(0, 32), "base64");
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 6 && head.subarray(0, 6).toString("latin1").startsWith("GIF8")) return "image/gif";
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return undefined;
}
