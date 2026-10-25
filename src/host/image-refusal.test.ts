/** An image the model refused (INV-1353): recognised by the provider's words, taken out with a note, and never sent when the bytes are not an image. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { imageRefusalOf, refusedImageNote, replaceRefusedImages, sniffImage } from "./image-refusal.ts";
import { classifyOverflow } from "./turn.ts";

const MINIMAX = '400 {"type":"error","error":{"type":"invalid_request_error","message":"invalid param: invalid image content: decode image config: image: unknown format (2013)"},"request_id":"072c"}';

test("the provider's refusal is recognised by its words and the reason is kept; other 400s are not", () => {
  assert.match(imageRefusalOf(new Error(MINIMAX)) ?? "", /invalid image content/);
  assert.equal(classifyOverflow(new Error(MINIMAX)), "refused-image");
  assert.equal(imageRefusalOf(new Error("400 invalid param: max_tokens too large")), undefined);
  assert.equal(classifyOverflow(new Error("request contained too many images or documents")), "too-many-images", "the count limit stays its own kind");
});

test("every image block, nested or not, becomes the same note; text is untouched", () => {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/webp", data: "AAAA" } }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "shot" }, { type: "image", source: { type: "base64", media_type: "image/webp", data: "BBBB" } }] }] },
  ];
  assert.equal(replaceRefusedImages(messages, "unknown format"), 2);
  assert.equal(JSON.stringify(messages).includes('"image"'), false);
  assert.equal(JSON.stringify(messages).split(refusedImageNote("unknown format")).length - 1, 2);
  assert.match(JSON.stringify(messages), /"look"/);
  assert.equal(replaceRefusedImages(messages, "again"), 0, "nothing left to replace");
});

test("bytes decide what is an image: png, jpeg, gif and webp signatures; text named .png is not one", () => {
  const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
  assert.equal(sniffImage(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])), "image/png");
  assert.equal(sniffImage(b64([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), "image/jpeg");
  assert.equal(sniffImage(Buffer.from("GIF89a\u0001\u0000", "latin1").toString("base64")), "image/gif");
  assert.equal(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 ")]).toString("base64")), "image/webp");
  assert.equal(sniffImage(Buffer.from("png").toString("base64")), undefined);
  assert.equal(sniffImage(Buffer.from("fake-png-bytes").toString("base64")), undefined);
});
