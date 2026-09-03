import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRunner, parseHooksConfig, refuseHooksFile } from "./hooks.ts";

test("a Claude Code settings file and a bare hooks object read the same", () => {
  const bare = parseHooksConfig({
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi", timeout: 5 }] }],
    Unknown: [{ hooks: [{ type: "command", command: "x" }] }],
    Stop: [{ hooks: [{ type: "prompt", prompt: "not supported" }] }],
  });
  assert.deepEqual(bare, {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi", timeout: 5 }] }],
  });
  const settings = parseHooksConfig({ permissions: {}, hooks: { Stop: [{ hooks: [{ type: "command", command: "date" }] }] } });
  assert.deepEqual(settings, { Stop: [{ hooks: [{ type: "command", command: "date" }] }] });
});

test("a hook blocks with exit 2 and stderr, or with JSON on stdout, and matches by tool name", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-hooks-"));
  try {
    const seen = join(root, "seen.jsonl");
    const script = join(root, "guard.sh");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        "input=$(cat)",
        `printf '%s\\n' "$input" >> ${seen}`,
        'case "$input" in',
        '  *"rm -rf"*) echo "no recursive deletes here" >&2; exit 2 ;;',
        '  *"git push"*) echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"pushes need a person"}}\'; exit 0 ;;',
        "esac",
        "exit 0",
      ].join("\n")
    );
    const path = join(root, "hooks.json");
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "bash|RunOnHost", hooks: [{ type: "command", command: `sh ${script}`, timeout: 5 }] }],
          Stop: [{ hooks: [{ type: "command", command: `echo stop >> ${join(root, "stops")}` }] }],
        },
      })
    );
    const lines: string[] = [];
    const runner = new HookRunner({ path, cwd: root, log: line => lines.push(line) });

    assert.equal(runner.has("PreToolUse", "bash"), true);
    assert.equal(runner.has("PreToolUse", "read_file"), false);
    assert.equal(runner.has("PreCompact"), false);

    const blocked = await runner.run("PreToolUse", { tool_name: "bash", tool_input: { command: "rm -rf /tmp/x" } });
    assert.deepEqual(blocked, { blocked: true, reason: "no recursive deletes here", ran: 1 });
    const denied = await runner.run("PreToolUse", { tool_name: "RunOnHost", tool_input: { command: "git push" } });
    assert.deepEqual(denied, { blocked: true, reason: "pushes need a person", ran: 1 });
    const fine = await runner.run("PreToolUse", { tool_name: "bash", tool_input: { command: "ls" } });
    assert.deepEqual(fine, { blocked: false, ran: 1 });
    const unmatched = await runner.run("PreToolUse", { tool_name: "read_file", tool_input: {} });
    assert.deepEqual(unmatched, { blocked: false, ran: 0 });

    const payloads = readFileSync(seen, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(payloads[0]?.hook_event_name, "PreToolUse");
    assert.equal(payloads[0]?.cwd, root);
    assert.deepEqual(payloads[0]?.tool_input, { command: "rm -rf /tmp/x" });

    await runner.run("Stop", { stop_hook_active: false });
    assert.equal(readFileSync(join(root, "stops"), "utf8"), "stop\n");

    // An edit takes effect without a restart.
    await new Promise(resolve => setTimeout(resolve, 10));
    writeFileSync(path, JSON.stringify({ PreToolUse: [] }));
    assert.equal(runner.has("PreToolUse", "bash"), false);
    assert.ok(lines.some(line => /loaded 2 hook matcher/.test(line)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hook that cannot run or times out is a log line, never a block", async () => {
  const lines: string[] = [];
  const runner = new HookRunner({
    path: null,
    config: {
      PreToolUse: [
        { hooks: [{ type: "command", command: "exit 7" }, { type: "command", command: "sleep 5", timeout: 1 }] },
      ],
    },
    log: line => lines.push(line),
  });
  const outcome = await runner.run("PreToolUse", { tool_name: "bash", tool_input: {} });
  assert.deepEqual(outcome, { blocked: false, ran: 2 });
  assert.ok(lines.some(line => /exited 7/.test(line)));
  assert.ok(lines.some(line => /timed out after 1s/.test(line)));
});

test("a hooks file somebody else could write is refused, not loaded (docs/10 S-9)", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-hooks-perm-"));
  try {
    const path = join(root, "hooks.json");
    const marker = join(root, "ran");
    writeFileSync(path, JSON.stringify({ Stop: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] }));
    const log: string[] = [];

    chmodSync(path, 0o666);
    const loose = new HookRunner({ path, log: line => log.push(line) });
    assert.equal(loose.has("Stop"), false, "a world-writable file contributes no hooks");
    assert.match(log.join("\n"), /refusing .*hooks\.json: writable by group or others \(mode 666\)/);

    // Fixed in place: the next look loads it, as the mtime rule already promises.
    chmodSync(path, 0o600);
    writeFileSync(path, JSON.stringify({ Stop: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] }));
    assert.equal(loose.has("Stop"), true);

    // The rule as a rule: ownership is checked too, where the platform has a uid.
    assert.equal(refuseHooksFile({ mode: 0o100644, uid: 1 }, 1), undefined);
    assert.match(refuseHooksFile({ mode: 0o100644, uid: 2 }, 1) ?? "", /owned by uid 2/);
    assert.match(refuseHooksFile({ mode: 0o100664, uid: 1 }, 1) ?? "", /mode 664/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
