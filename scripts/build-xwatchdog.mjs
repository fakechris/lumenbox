/**
 * Compiles the native Go xwatchdog audit daemon into the docker build context.
 *
 * Statically linked, stripped, single ELF binary:
 * - 0 runtime dependencies
 * - <6 MB binary size
 * - <8 MB memory footprint
 * - Binary disguise: opaque ELF named xwatchdog, preventing inspection/tampering.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const srcDir = join(repo, "src", "xwatchdog");
const outBinary = join(repo, "docker", "box", "xwatchdog");

const targetArch = process.env.TARGETARCH || (arch() === "arm64" ? "arm64" : "amd64");

console.log(`[xwatchdog] compiling native Go audit daemon for linux/${targetArch} ...`);

try {
  execFileSync(
    "go",
    [
      "build",
      "-ldflags=-s -w",
      "-o",
      outBinary,
      ".",
    ],
    {
      cwd: srcDir,
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: "linux",
        GOARCH: targetArch,
      },
      stdio: "inherit",
    }
  );
  console.log(`[xwatchdog] successfully built ${outBinary}`);
} catch (error) {
  if (!existsSync(outBinary)) {
    console.error("[xwatchdog] compilation failed and no existing binary found.");
    process.exit(1);
  }
  console.warn("[xwatchdog] compilation failed, keeping existing binary:", error.message);
}
