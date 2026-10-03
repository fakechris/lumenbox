/** Box-doctor uses the same format checker as the host's delivery gate (INV-713). */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDeliverable, isBroken } from "../host/deliverables.ts";

const directory = mkdtempSync(join(tmpdir(), "box-documents-"));
try {
  execFileSync("python3", ["/opt/box-checks/documents.py", directory], {
    env: { ...process.env, MPLCONFIGDIR: join(directory, "matplotlib"), PYTHONOPTIMIZE: "0" },
    timeout: 25_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const extension of ["docx", "xlsx", "pptx", "pdf"]) {
    const name = `check.${extension}`;
    const problems = checkDeliverable(name, readFileSync(join(directory, name)));
    if (isBroken(problems)) throw new Error(`${name}: ${JSON.stringify(problems)}`);
  }
  console.log("docx/xlsx/pptx/pdf generated, reopened and passed checkDeliverable; image/chart libraries work");
} catch (error) {
  // execFileSync's message includes Python's stderr (including missing imports).
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
