/** The JPEG copy of a frame (INV-1417): one frame in, one JPEG out, temp files gone, a mark drawn where asked. */

import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { jpegArgs, webpToJpeg } from "./jpeg.ts";

test("the frame is converted through temp files that are removed, with a red box only when a mark is given", async () => {
  const seen: string[][] = [];
  const out = await webpToJpeg(Buffer.from("WEBPDATA").toString("base64"), {
    run: async (_command, args) => {
      seen.push(args);
      writeFileSync(args[args.length - 1]!, "JPEGDATA");
    },
  });
  assert.equal(Buffer.from(out, "base64").toString(), "JPEGDATA");
  assert.ok(!seen[0]!.includes("-vf"));
  for (const path of [seen[0]![seen[0]!.indexOf("-i") + 1]!, seen[0]![seen[0]!.length - 1]!]) assert.ok(!existsSync(path), `${path} is removed`);
  assert.deepEqual(jpegArgs("in.webp", "out.jpg", { x: 10.4, y: 20, width: 30, height: 40 }).slice(4, 6), ["-vf", "drawbox=x=10:y=20:w=30:h=40:color=red@0.9:t=4"]);
});

test("a failed conversion throws and still leaves nothing behind", async () => {
  let input = "";
  await assert.rejects(webpToJpeg("AAAA", { run: async (_c, args) => { input = args[args.indexOf("-i") + 1]!; throw new Error("ffmpeg died"); } }), /ffmpeg died/);
  assert.ok(!existsSync(input));
});
