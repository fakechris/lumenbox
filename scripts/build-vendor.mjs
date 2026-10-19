/**
 * Bundles the browser side of ShowUI (src/web/a2ui-entry.ts) into vendor/a2ui.js: the A2UI
 * message processor, the Lit renderer and the lumenbox catalog, as one script the page
 * loads from this server. Like markdown-it, served locally so the UI works with no network
 * and stays on the locked version; unlike it, derived from src/, so it is not committed —
 * `npm run build` makes it, and the box image copies it in beside hostd.
 */

import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "vendor", "a2ui.js");

mkdirSync(dirname(out), { recursive: true });
await build({
  entryPoints: [join(root, "src/web/a2ui-entry.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  outfile: out,
  logLevel: "warning",
});
// The box image's build context (docker/box) takes a copy, as it does of hostd.
copyFileSync(out, join(root, "docker/box/a2ui.js"));
console.log(`built ${out}`);
