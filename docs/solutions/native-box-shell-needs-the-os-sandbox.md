---
module: boxd headless
tags: [host-box, sandbox, sandbox-exec, bwrap, security]
problem_type: best-practice
found: 2026-11-07, INV-1700
---
# On a host box, a path check on the file routes does not confine the shell

**Symptom.** A native-environment box (`kind: "host"`, `agentbox host up`) refuses `write_file` outside its granted directories, yet `bash` writes to `~/.zshrc`, reads `~/.ssh`, or runs `rm -rf` on a directory nobody granted. The writes are logged as "writes on the person's own machine" and nothing stops them.

**Cause.** `headless.ts` checks paths only for the file routes. `POST /exec`, background jobs and delegated engines (`/acp/open`) all spawn `bash` as the daemon's user. Inside a container that is acceptable because Docker is the wall. On someone's own machine there is no wall. The host-side "review" of those writes was an auto-review verdict in `shadow` mode, which records and never blocks.

**Fix.** Every process boxd starts for an agent on a headless box goes through `confinementFor()` (`src/boxd/confinement.ts`), which wraps it in the `RunOnHost` sandbox (`src/host/host-sandbox.ts`). The sandbox is `sandbox-exec` on macOS and `bwrap` on Linux. Writes are allowed only in rw roots, the work directory, `$TMPDIR` and `/tmp`. ro roots stay read-only even under an rw root. Credential places cannot be read. The only network is the egress proxy. When the sandbox is unavailable, the wrap throws `ConfinementRefused` (HTTP 403) and nothing runs: never fall back to bare. On the host, the policy gate asks before any write on a host box (`hostBoxWrite`, `onHostBox` set by dispatch). Read-only commands do not ask (`shell-readonly.ts`). An operator `allow` rule with `tool:`/`command:`/`path:` lifts the ask. Watch for these:
- Pass the start directory as `runIn`, never as `cwd`. `cwd` becomes writable, so a request with `cwd: ~` would open the whole home directory.
- Seatbelt matches real paths, so resolve everything first. On macOS `/tmp` is `/private/tmp`, and the session wrapper writes `/tmp/boxd-session-*`.
- `bwrap --ro-bind` fails on a path that does not exist. The deny and read-only lists keep only existing paths.
- Under the sandbox, tools that write caches under `$HOME` (`~/.npm`, `~/.cache`) are refused. Point them into the work directory, or grant the directory rw.

**Verify.** `node --experimental-transform-types --test src/boxd/confinement.test.ts`. Its last test runs real commands under the real sandbox where one is available, and is skipped where it is not, including under a sandboxed test runner. It checks that a write outside the roots fails and leaves no file, that a ro root is not writable, that `~/.ssh` cannot be read, and that `rm -rf` outside the roots removes nothing. `boxd` started headless logs `commands run under sandbox-exec: …` at start-up. With the sandbox missing, it logs `every command is refused`.
