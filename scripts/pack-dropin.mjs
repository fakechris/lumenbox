#!/usr/bin/env node
/**
 * Packages the Lumenbox Drop-in Sidecar bundle.
 *
 * Produces dist/lumen-dropin.tar.gz containing the standalone boxd daemon,
 * adaptive start-display, adaptive box-chrome, and box-keepalive watchdog.
 * This tarball can be deployed directly into existing container environments
 * like Grok Bot's cloud VM without root privileges.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const dockerBox = join(root, "docker", "box");
const outputFile = join(dist, "lumen-dropin.tar.gz");

mkdirSync(dist, { recursive: true });

const requiredFiles = ["boxd.cjs", "start-display", "box-chrome", "box-keepalive", "wait-compositor", "vnc-probe", "box-clip", "lumen-bridge.sh"];

for (const file of requiredFiles) {
  const fullPath = join(dockerBox, file);
  if (!existsSync(fullPath)) {
    console.error(`[pack-dropin] ERROR: Required file missing: ${fullPath}`);
    console.error(`[pack-dropin] Run 'npm run build:boxd' first.`);
    process.exit(1);
  }
}

console.log("[pack-dropin] Packaging drop-in sidecar archive...");
// No macOS resource forks or xattrs in the archive: a Linux tar prints a warning per file
// for `com.apple.provenance`, and the person reading the installer's output takes it for an error.
execFileSync("tar", ["--no-xattrs", "-czf", outputFile, "-C", dockerBox, ...requiredFiles], {
  stdio: "inherit",
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});

const sizeBytes = statSync(outputFile).size;
const sizeKb = (sizeBytes / 1024).toFixed(1);
console.log(`[pack-dropin] Successfully created ${outputFile} (${sizeKb} KB)`);
