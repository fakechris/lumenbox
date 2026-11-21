import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { copyCatalogData } from "./copy-catalog-data.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = process.argv[2] ? resolve(process.argv[2]) : join(root, "docker/box");
const { name, version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const buildCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

await build({
  absWorkingDir: root, entryPoints: ["src/cli.ts"], outfile: join(out, "hostd.mjs"),
  bundle: true, platform: "node", target: "node22", format: "esm", logLevel: "info",
});
copyCatalogData(out);
writeFileSync(join(out, "package.json"), `${JSON.stringify({ name, version, buildCommit })}\n`);
