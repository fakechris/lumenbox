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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const srcDir = join(repo, "src", "xwatchdog");
for (const targetArch of ["amd64", "arm64"]) {
  const outBinary = join(repo, "docker", "box", `xwatchdog-${targetArch}`);
  console.log(`[xwatchdog] compiling native Go audit daemon for linux/${targetArch} ...`);
  try {
    execFileSync("go", ["build", "-ldflags=-s -w", "-o", outBinary, "."], {
      cwd: srcDir,
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: "linux",
        GOARCH: targetArch,
      },
      stdio: "inherit",
    });
    console.log(`[xwatchdog] successfully built ${outBinary}`);
  } catch (error) {
    console.error(`[xwatchdog] compilation failed for linux/${targetArch}: ${error.message}`);
    process.exit(1);
  }
}
