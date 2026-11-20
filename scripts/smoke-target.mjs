import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNotLiveBox, boxMode } from "./lib/eval-box.mjs";
import { BOX_OWNER_FILENAME, PROFILE_FILENAME } from "../src/agents/registry.ts";

export function smokeTarget(argv, env, liveName) {
  const live = argv.includes("--live-box");
  const url = env.AGENTBOX_BOXD_URL?.trim();
  const chosen = live && !argv.includes("--box") && env.AGENTBOX_CONTAINER === undefined
    ? { mode: "use", name: liveName } : boxMode(argv, env);
  if (chosen.mode === "use" && !live) assertNotLiveBox(chosen.name, liveName);
  if (argv.includes("--box") && argv[argv.indexOf("--box") + 1] === undefined) {
    throw new Error("--box needs create, keep or use <name>.");
  }
  return { live, ...(url ? { mode: "attached", url } : chosen) };
}

export function smokeHome(env) {
  const home = mkdtempSync(join(tmpdir(), "lumenbox-smoke-"));
  env.AGENTBOX_HOME = home;
  env.AGENTBOX_AGENTS_DIR = join(home, "agents");
  return { home, close: () => rmSync(home, { recursive: true, force: true }) };
}

export function liveOwners(root) {
  const owners = new Map();
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return owners;
    throw error;
  }
  for (const entry of entries.filter(entry => entry.isDirectory())) {
    try {
      const profile = JSON.parse(readFileSync(join(root, entry.name, PROFILE_FILENAME), "utf8"));
      const token = readFileSync(join(root, entry.name, BOX_OWNER_FILENAME), "utf8").trim();
      if (token) owners.set(profile.displayIndex, token);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return owners;
}
