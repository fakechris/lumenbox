/**
 * Where a delegated engine's files go (INV-1712): on a Docker box exactly where they always went,
 * on a host box inside the work directory and the agent's state directory — and, under the real
 * sandbox, a fake engine started the way Delegate starts it finds its config, its MCP face and its
 * skills there. Hermetic: temporary directories and a fake home, never the real one.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { boxPaths, DOCKER_BOX_PATHS, type BoxPaths } from "./box-paths.ts";
import { delegateCommand, installCommand, PRESETS, presetNamed, quoteForShell, skillsLink } from "./presets.ts";
import { reportPath } from "./delegate-report.ts";
import { HostSandbox } from "./host-sandbox.ts";
import { confinementFor, stateEnvironment } from "../boxd/confinement.ts";
import { Roots } from "../boxd/headless.ts";
import { JobService } from "../boxd/job-service.ts";

/** Every file and directory one delegation names in the box, for each preset. */
function everyPath(paths: BoxPaths, name: string): string[] {
  const preset = presetNamed(name)!;
  const config = preset.relayConfig?.("http://host/relay/r", "LUMENBOX_RELAY_TOKEN", "anthropic", "m", paths);
  const env = preset.relayEnv("http://host/relay/r", "tok", "m", paths);
  const lines = [installCommand(preset, paths), delegateCommand(preset, paths, preset.run("'x'", "m")), skillsLink(preset, paths) ?? ""];
  const absolute = lines.flatMap(line => line.match(/(?<![\w@~-])\/[A-Za-z0-9._/@+-]+/g) ?? []);
  return [
    ...absolute,
    ...(config !== undefined ? [config.file] : []),
    ...Object.values(env).filter(value => value.startsWith("/")),
    `${paths.mcpFaces}/route.json`,
    reportPath("job-1", paths),
    paths.work,
  ];
}

test("a Docker box gets byte for byte what it always got: the image's homes, the work volume, the links made at install", () => {
  const engines = "/home/box/work/.lumenbox/engines";
  const linked: Record<string, string> = {
    opencode: "mkdir -p ~/.config/opencode && ln -sfn /home/box/work/skills ~/.config/opencode/skill",
    claude: "mkdir -p ~/.claude && ln -sfn /home/box/work/skills ~/.claude/skills",
    pi: "mkdir -p ~/.pi/agent && ln -sfn /home/box/work/skills ~/.pi/agent/skills",
    mcode: "mkdir -p ~/.agents && ln -sfn /home/box/work/skills ~/.agents/skills",
  };
  for (const kind of ["docker", "attached"] as const) {
    const paths = boxPaths({ kind, workDir: "/somewhere/else" }, "a1");
    assert.equal(paths, DOCKER_BOX_PATHS, `${kind}: the image's layout, whatever the record says`);
    for (const preset of PRESETS) {
      const { package: pkg, version, ignoreScripts } = preset.install;
      assert.equal(
        installCommand(preset, paths),
        `mkdir -p ${engines} && npm install -g --prefix ${engines}${ignoreScripts ? " --ignore-scripts" : ""} ${quoteForShell(`${pkg}@${version}`)} && ${linked[preset.name]} && echo "installed ${preset.name} ${version} under ${engines}"`
      );
      assert.equal(delegateCommand(preset, paths, "RUN"), `export PATH="$PATH:${engines}/bin"; RUN`, `${preset.name}: no link before the run`);
    }
  }
  const files = Object.fromEntries(["opencode", "pi", "mcode"].map(name => [name, presetNamed(name)!.relayConfig!("u", "T", "anthropic", "m", DOCKER_BOX_PATHS).file]));
  assert.deepEqual(files, { opencode: "/home/box/.config/opencode/opencode.json", pi: "/home/box/.pi/agent/models.json", mcode: "/home/box/.agents/mcode-relay.json" });
  assert.equal(presetNamed("claude")!.relayEnv("u", "t", undefined, DOCKER_BOX_PATHS).CLAUDE_CONFIG_DIR, "/home/box/.claude");
  assert.equal(DOCKER_BOX_PATHS.mcpFaces, "/home/box/work/.lumenbox/mcp");
  assert.equal(reportPath("job-1", DOCKER_BOX_PATHS), "/home/box/work/.lumenbox/reports/job-1.json");
});

test("on a host box every path a delegation names is in the work directory, the engine homes in the agent's state directory", () => {
  const work = "/Users/someone/agentbox-work";
  const paths = boxPaths({ kind: "host", workDir: `${work}/` }, "a1") as BoxPaths;
  for (const preset of PRESETS) {
    for (const path of everyPath(paths, preset.name)) {
      // mcode's per-run profile is a mktemp under /tmp, writable on every box and removed when the run ends.
      assert.ok(path === work || path.startsWith(`${work}/`) || path.startsWith("/tmp/mcode."), `${preset.name}: ${path} is outside ${work}`);
    }
    assert.doesNotMatch(installCommand(preset, paths), /ln -sfn/, `${preset.name}: the install is no one agent's, so it links nothing`);
  }
  // The engine homes are where the box points the engines (STATE_VARIABLES, one table for both sides).
  const state = mkdtempSync(join(tmpdir(), "box-paths-state-"));
  try {
    const hostPaths = boxPaths({ kind: "host", workDir: state }, "a1") as BoxPaths;
    const env = stateEnvironment(join(state, ".state", "a1"));
    assert.equal(hostPaths.homes.claude, env.CLAUDE_CONFIG_DIR);
    assert.equal(hostPaths.homes.pi, env.PI_CODING_AGENT_DIR);
    assert.equal(hostPaths.homes.opencode, join(env.XDG_CONFIG_HOME!, "opencode"));
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
  assert.equal(skillsLink(presetNamed("mcode")!, paths), undefined, "mcode reads ~/.agents, which is the person's here: no mount, rather than one it never reads");
  assert.match(delegateCommand(presetNamed("claude")!, paths, "RUN"), new RegExp(`ln -sfn ${work}/skills ${work}/\\.state/a1/claude/skills && RUN$`));
  for (const bad of [undefined, "", "/", "relative/work", "/Users/some one/work", "/w/$(x)"]) {
    const refused = boxPaths({ kind: "host", ...(bad !== undefined ? { workDir: bad } : {}) }, "a1");
    assert.ok("error" in refused, `${String(bad)} is refused`);
    assert.match(refused.error, /agentbox host up --work/);
  }
});

const live = new HostSandbox();

test("under the real sandbox: an engine started as Delegate starts it on a host box reads its config, its MCP face and the box's skills, and writes only its state directory", { skip: live.unavailableReason() }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "box-paths-host-")));
  const home = join(root, "home");
  const work = join(root, "home", "work");
  const tmp = join(root, "tmp");
  try {
    for (const dir of [home, work, tmp, join(work, "skills", "hello")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(work, "skills", "hello", "SKILL.md"), "hello skill\n");
    const confine = confinementFor({ headless: true, roots: () => new Roots([{ path: work, mode: "rw" }]), workDir: work, egressPort: () => undefined, log: () => {}, systemTmp: tmp, sandbox: new HostSandbox({ home, tmp }) })!;
    const paths = boxPaths({ kind: "host", workDir: work }, "a1") as BoxPaths;
    const roots = new Roots([{ path: work, mode: "rw" }]);
    // What each fake engine reads is where the real one reads (measured: claude --mcp-config and
    // CLAUDE_CONFIG_DIR/skills; opencode $OPENCODE_CONFIG and $XDG_CONFIG_HOME/opencode; pi $PI_CODING_AGENT_DIR).
    const reads: Record<string, string> = {
      claude: 'for a in "$@"; do case "$a" in *.json) cat "$a";; esac; done; cat "$CLAUDE_CONFIG_DIR/skills/hello/SKILL.md"; echo s > "$CLAUDE_CONFIG_DIR/state.json"',
      opencode: 'cat "$OPENCODE_CONFIG" "$XDG_CONFIG_HOME/opencode/opencode.json" "$XDG_CONFIG_HOME/opencode/skill/hello/SKILL.md"',
      pi: 'cat "$PI_CODING_AGENT_DIR/models.json" "$PI_CODING_AGENT_DIR/skills/hello/SKILL.md"',
    };
    // A bare PATH, so the fake engines below are the ones found (an image's own engine comes first by design).
    mkdirSync(paths.enginesBin, { recursive: true });
    const jobs = new JobService(join(work, ".jobs"));
    for (const [name, script] of Object.entries(reads)) {
      const preset = presetNamed(name)!;
      writeFileSync(join(paths.enginesBin, name), `#!/bin/sh\n${script}\n`);
      chmodSync(join(paths.enginesBin, name), 0o755);
      // What the host writes before the start, each through the box's file routes, which refuse outside the roots.
      const faceFile = `${paths.mcpFaces}/route-${name}.json`;
      const face = preset.mcpFace("http://127.0.0.1:1/mcp/r/abc", "LUMENBOX_MCP_TOKEN", faceFile);
      const config = preset.relayConfig?.("http://127.0.0.1:1/relay/r", "LUMENBOX_RELAY_TOKEN", "anthropic", "m", paths);
      for (const [file, content] of [[faceFile, face.content], ...(config !== undefined ? [[config.file, config.content]] : [])] as [string, string][]) {
        assert.equal(roots.refusal(file, "rw"), undefined, `${name}: ${file} is writable through the box`);
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, content);
      }
      const env = { ...preset.relayEnv("http://127.0.0.1:1/relay/r", "tok", "m", paths), ...config?.env, ...face.env, LUMENBOX_MCP_TOKEN: "t" };
      const job = jobs.start({ command: delegateCommand(preset, paths, preset.run("'go'", "m", face.args || undefined)), cwd: work, nice: 0, env, scrubbedEnv: { PATH: "/usr/bin:/bin", HOME: home }, actor: "agent:a1", confine });
      const ended = await jobs.wait({ job_id: job.job_id, timeout_ms: 20_000 });
      const log = readFileSync(job.log_path, "utf8");
      assert.equal(ended?.exit_code, 0, `${name}: ${log}`);
      assert.match(log, /hello skill/, `${name} found the box's skills`);
      if (name !== "pi") assert.match(log, /mcp\/r\/abc/, `${name} read its MCP face`);
      if (config !== undefined) assert.ok(log.includes(config.content.trim().split("\n")[1]!), `${name} read its relay config`);
    }
    assert.ok(existsSync(join(work, ".state", "a1", "claude", "state.json")), "the engine's own state landed in the agent's directory");
    assert.deepEqual(readdirSync(home).sort(), ["work"], "and nothing in the home");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
