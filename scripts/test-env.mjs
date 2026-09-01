/**
 * The environment a test run is allowed to see.
 *
 * Tests here run on the same machine as a live installation: real channel credentials in
 * the shell, a real `~/.agentbox` full of a person's conversations, a real box. Anything
 * a test reads from that environment is a difference between the run on this laptop and
 * the run in CI — the "works locally, fails in CI" class, and its more expensive mirror,
 * a test that quietly passes because a key happened to be exported.
 *
 * So the run gets an allowlist rather than the ambient environment. This is the shape
 * both mature harnesses converged on: Hermes launches pytest under `env -i` with an
 * explicit list (`scripts/run_tests.sh`), and OpenClaw actively deletes vendor tokens
 * from the test environment (`test/test-env.ts`). The list is deliberately written out
 * rather than expressed as a pattern, so "no credential can reach a test" stays true by
 * reading it.
 *
 * `AGENTBOX_TEST=1` is the flag the code itself checks: `agentboxHome()` refuses its
 * default under it, so a test that forgets its temp directory fails instead of appending
 * to the live installation.
 */

/** Variables a test may see. Everything else is dropped. */
const KEEP = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "USER",
  "LOGNAME",
  // Node's own knobs: dropping these would change how the runner itself behaves.
  "NODE_OPTIONS",
  "NODE_V8_COVERAGE",
  "NODE_TEST_CONTEXT",
  // Windows needs these to resolve a home directory at all.
  "SystemRoot",
  "SYSTEMROOT",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ComSpec",
  // CI identifies itself; a few tests reasonably behave differently there.
  "CI",
  "GITHUB_ACTIONS",
];

/** Test-run knobs, passed through so a person can still tune one run. */
const KEEP_PREFIXES = ["AGENTBOX_TEST", "NODE_TEST"];

export function hermeticEnv(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (KEEP.includes(key) || KEEP_PREFIXES.some(prefix => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  // Deterministic by construction: a test that formats a date or sorts strings must not
  // depend on where the machine happens to be.
  env.TZ = "UTC";
  env.LANG = "C.UTF-8";
  env.LC_ALL = "C.UTF-8";
  // What `agentboxHome()` and any future guard key on.
  env.AGENTBOX_TEST = "1";
  return env;
}
