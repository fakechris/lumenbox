/**
 * Puts the catalog's data files next to the bundle that reads them.
 *
 * `catalog.ts` resolves personas and vendored skill packages against its own module URL,
 * which is right in the source tree and wrong the moment esbuild flattens the module into
 * one file: the bundle at `dist/cli.js` looks for `dist/catalog-data/`, which nothing put
 * there. The packaged CLI died on its first import — `agentbox --help` included — while
 * every test and every `node src/cli.ts` run stayed green, because in the source tree the
 * files are exactly where the module expects them.
 *
 * Found by scripts/release-check.mjs on the day it was written (2026-09-01), one commit
 * after the catalog landed. Data that code reads at runtime is part of the artifact; a
 * bundler that only knows about imports cannot know that, so the build has to say it.
 */

import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export function copyCatalogData(outDir) {
  mkdirSync(outDir, { recursive: true });
  cpSync(join(root, "src/host/catalog-data"), join(outDir, "catalog-data"), { recursive: true });
  console.log(`[catalog-data] -> ${join(outDir, "catalog-data")}`);
}

if (import.meta.main) copyCatalogData(join(root, "dist"));
