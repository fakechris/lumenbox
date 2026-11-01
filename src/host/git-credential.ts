/**
 * A git token handed to git and to nothing else (INV-1408).
 *
 * A vault secret placed in a host command's environment is read by every process under that
 * command — the build script, an npm postinstall, the tests — and any of them may print it;
 * the outbound redaction is the last line, not the first. Git has its own way to be given a
 * credential: a helper, asked per request with the protocol and host, answering with a
 * username and password. So a secret marked `git` is never put in the environment. For the
 * one run, a private directory holds a helper script per credential and the token in a 0600
 * file beside it; git is pointed at the helpers through `GIT_CONFIG_*` variables, which touch
 * no gitconfig and die with the command. The helper answers only `https` to the hosts the
 * secret names, says nothing for anything else, and notes an `erase` — git telling it the
 * credential was refused — so the run's result can say so. The directory is removed when the
 * run ends, token and all.
 *
 * The first helper entry is empty, which resets git's helper list: the person's own keychain
 * helper is not consulted for an agent's command, so the agent's git reaches only what the
 * agent was granted.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitCredential {
  /** The vault secret id, named in logs and results; never the value. */
  id: string;
  value: string;
  /** Hosts the helper answers for; github.com when the secret names none. */
  hosts: readonly string[];
}

export const DEFAULT_GIT_HOST = "github.com";

export interface PreparedGitCredentials {
  /** `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`: the helpers, for this run's environment. */
  env: Record<string, string>;
  dir: string;
  /** Removes the directory, tokens included, and says which hosts git reported a refused credential for. */
  finish(): { erased: string[] };
}

/** The helper script: stdin is git's key=value description of the request; `$1` is get, store or erase. */
function helperScript(tokenFile: string, eventsFile: string, hosts: readonly string[]): string {
  const cases = hosts.map(host => `"${host.replace(/"/g, "")}"`).join("|");
  return [
    "#!/bin/sh",
    "# One-run git credential helper written by the host (INV-1408): answers https to the named hosts only.",
    'op="$1"; proto=""; host=""',
    "while IFS= read -r line; do",
    '  case "$line" in protocol=*) proto="${line#protocol=}";; host=*) host="${line#host=}";; esac',
    "done",
    'case "$op" in',
    `  get) [ "$proto" = https ] || exit 0; case "$host" in ${cases}) printf 'username=x-access-token\\npassword=%s\\n' "$(cat "${tokenFile}")";; esac;;`,
    `  erase) printf 'erase %s\\n' "$host" >> "${eventsFile}";;`,
    "esac",
    "exit 0",
    "",
  ].join("\n");
}

export function prepareGitCredentials(credentials: readonly GitCredential[], base = tmpdir()): PreparedGitCredentials {
  const dir = mkdtempSync(join(base, "agentbox-git-"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const eventsFile = join(dir, "events");
  writeFileSync(eventsFile, "", { mode: 0o600 });
  // Entry 0 is the empty string: git takes it as "forget the helpers configured so far".
  const env: Record<string, string> = { GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "" };
  credentials.forEach((credential, index) => {
    const tokenFile = join(dir, `token-${index}`);
    const helper = join(dir, `helper-${index}`);
    writeFileSync(tokenFile, credential.value, { mode: 0o600 });
    writeFileSync(helper, helperScript(tokenFile, eventsFile, credential.hosts.length > 0 ? credential.hosts : [DEFAULT_GIT_HOST]), { mode: 0o700 });
    env[`GIT_CONFIG_KEY_${index + 1}`] = "credential.helper";
    env[`GIT_CONFIG_VALUE_${index + 1}`] = helper;
  });
  env.GIT_CONFIG_COUNT = String(credentials.length + 1);
  // No terminal to ask on: a host git asks a helper or fails, never hangs on a prompt.
  env.GIT_TERMINAL_PROMPT = "0";
  return {
    env,
    dir,
    finish() {
      let erased: string[] = [];
      try {
        erased = [...new Set(readFileSync(eventsFile, "utf8").split("\n").filter(line => line.startsWith("erase ")).map(line => line.slice("erase ".length).trim()))];
      } catch {
        // The directory was already gone: nothing to report.
      }
      rmSync(dir, { recursive: true, force: true });
      return { erased };
    },
  };
}
