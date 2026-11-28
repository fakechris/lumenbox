import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { logsDir, serverLog } = createRequire(import.meta.url)("../../electron/shell-logs.cjs") as {
  logsDir(env: Record<string, string | undefined>, home: string): string;
  serverLog(dir: string): (text: string) => void;
};

test("the shell writes its server log where LUMENBOX_LOGS_DIR says, and in ~/Library/Logs/LumenBox when it says nothing (INV-2307)", t => {
  const root = mkdtempSync(join(tmpdir(), "shell-logs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const usual = join(home, "Library", "Logs", "LumenBox");
  const run = join(root, "run", "full", "logs");

  serverLog(logsDir({ LUMENBOX_LOGS_DIR: run }, home))("config: /run/full/home/config.json\n");
  assert.match(readFileSync(join(run, "server.log"), "utf8"), /^\S+Z config: \/run\/full\/home\/config\.json\n$/, "a stamped line in the run's own directory");
  assert.equal(existsSync(usual), false, "nothing under the person's own logs directory");

  for (const unset of [{}, { LUMENBOX_LOGS_DIR: "" }]) assert.equal(logsDir(unset, home), usual);
  serverLog(logsDir({}, home))("listening\n");
  assert.match(readFileSync(join(usual, "server.log"), "utf8"), /listening/);
});
