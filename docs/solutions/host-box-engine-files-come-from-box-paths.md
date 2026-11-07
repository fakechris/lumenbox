---
module: host presets
tags: [host-box, delegate, presets, sandbox, skills]
problem_type: best-practice
found: 2026-11-07, INV-1712
---
# On a host box, a delegated engine's files cannot be at the image's /home/box paths

**Symptom.** On a native-environment box (`kind: "host"`), `Delegate` fails before the engine starts. The box refuses to write the MCP face file or the relay config (`/home/box/... is outside the directories this box may touch`). Or the engine starts but cannot find its provider config, its skills or its report path. The work volume, the engine homes and the install prefix were all hard-coded to the Docker image's layout.

**Cause.** The presets and the Delegate tool named `/home/box/work/...` and `~/.claude`, `~/.config/opencode`, `~/.pi/agent`, `~/.agents` directly. On someone's own machine `/home/box` does not exist, and `~` belongs to that person: the sandbox refuses writes there (INV-1700) and hides their engine logins (INV-1710).

**Fix.** Every path a delegation names comes from `boxPaths({ kind, workDir }, agentId)` in `src/host/box-paths.ts`. Never test the box kind in a preset or a tool. A Docker or attached box gets `DOCKER_BOX_PATHS`, which are exactly the old paths (`box-paths.test.ts` checks them byte for byte). A host box gets its work directory from the registry entry. Each engine home sits under `<work>/.state/<agent>`, at the subdirectory `STATE_VARIABLES` gives (one table: boxd's `stateEnvironment` points the engines there, and the host derives the file paths from the same table). The skills links are made before each run (`delegateCommand`), not at install, because the install belongs to no single agent. pi is pointed with `PI_CODING_AGENT_DIR` (measured on 0.85.1). mcode reads `~/.agents/skills` and has no variable to move it, so on a host box it gets no skills mount. The report path is recorded with the delegation (`data.report`), so settling reads the file the brief named. Watch for these:
- The engines' `bin` is **appended** to PATH, so an engine the person installed themselves (Homebrew, `~/.local/bin`) is found first on a host box and runs instead of the pinned one. It still runs under the sandbox and keeps its state in the agent's state directory. A test that starts a fake engine must use a bare PATH, or it runs the real one.
- A host work directory is spliced into shell lines unquoted, so `boxPaths` refuses one that would need quoting and says to restart with `agentbox host up --work`.

**Verify.** `node --experimental-transform-types --test src/host/box-paths.test.ts`, run outside a sandboxed test runner so the real sandbox is available. Under that sandbox, fake claude, opencode and pi binaries are started the way Delegate starts them. Each reads its MCP face, its relay config and a skill linked from `<work>/skills`. Claude's state lands in `<work>/.state/a1/claude`, and the fake home stays empty. `src/host/mcp-face.test.ts` runs the Delegate tool against a host box and checks that the face file and the skills link are under the work directory.
