/**
 * The secrets a host command asked for, resolved against the agent's grants and sorted by how
 * each reaches the command (INV-1408): an ordinary secret goes into the environment for the
 * run; a secret marked `git` goes to git through a one-run credential helper and never into
 * the environment — unless the command is `gh` itself, which reads GH_TOKEN and is the one
 * process the token was for.
 */

import { type GitCredential, prepareGitCredentials } from "./git-credential.ts";
import type { Vault } from "./vault.ts";

export interface HostSecretsCaller {
  agentId: string;
  agentName?: string;
  principalId?: string;
  scopeGrants(secretId: string): boolean;
}

export interface HostSecrets {
  /** What goes into the command's environment: ordinary secrets by id, plus the helper variables for git ones. */
  env: Record<string, string>;
  /** Secrets the agent asked for and has not been granted. */
  refused: string[];
  /** Ids placed in the environment. */
  inEnvironment: string[];
  /** Ids handed to git through the helper. */
  toGit: string[];
  /** Removes the helper directory; says which hosts git reported the credential refused for. */
  finish(): { erased: string[] };
}

/** Whether the command is the GitHub CLI itself, so the token may be its GH_TOKEN. */
export const isGhCommand = (command: string): boolean => /^\s*gh(\s|$)/.test(command);

export function resolveHostSecrets(vault: Vault | undefined, asked: readonly unknown[], command: string, caller: HostSecretsCaller): HostSecrets {
  const env: Record<string, string> = {};
  const refused: string[] = [];
  const inEnvironment: string[] = [];
  const git: GitCredential[] = [];
  for (const raw of asked) {
    const id = String(raw);
    const value = vault?.resolve(id, {
      agentId: caller.agentId,
      ...(caller.agentName !== undefined ? { agentName: caller.agentName } : {}),
      ...(caller.principalId !== undefined ? { principalId: caller.principalId } : {}),
      scopeGrants: caller.scopeGrants(id),
    });
    if (value === undefined) {
      refused.push(id);
      continue;
    }
    if (vault?.kindOf?.(id) === "git") {
      git.push({ id, value, hosts: vault.domainsOf(id) });
      if (isGhCommand(command)) {
        env.GH_TOKEN = value;
        inEnvironment.push(`${id} (as GH_TOKEN, for gh)`);
      }
      continue;
    }
    env[id] = value;
    inEnvironment.push(id);
  }
  if (git.length === 0) return { env, refused, inEnvironment, toGit: [], finish: () => ({ erased: [] }) };
  const prepared = prepareGitCredentials(git);
  return { env: { ...env, ...prepared.env }, refused, inEnvironment, toGit: git.map(credential => credential.id), finish: prepared.finish };
}
