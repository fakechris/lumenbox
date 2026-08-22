/**
 * The credential vault: named secrets, granted to who may use them, used only where
 * they never enter the box.
 *
 * The framework this answers to asks for a keychain that is scope-granted, short-lived,
 * revocable, kept out of the prompt, and audited. This is the smallest thing that is
 * all of those and honest about its one boundary: a secret here is delivered *only*
 * through `RunOnHost`, which runs on the operator's own machine, outside the box — so
 * the value reaches a `git push` or a `gh` call without ever being written into a file,
 * an environment, or a dotfile inside the container. A secret an agent needs *inside*
 * the box cannot be kept out of it by definition, and this vault does not pretend
 * otherwise; it refuses that case rather than leaking into it.
 *
 * A Grant is the Scope seed. Today a holder is an agent, a principal, or everyone, and
 * the only capability is "use this secret". The shape — holder, resource, expiry — is
 * the one the wider Scope object will grow into, so the data written now does not have
 * to be migrated when it does.
 *
 * ~/.agentbox/vault.json, 0600. Values live here and are never returned by any read
 * path; a list shows a secret's name, description and grants, never its value. Every
 * resolution — allowed or refused — is appended to an audit log, because a credential
 * whose use leaves no trace is the thing an audit exists to prevent.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";

/**
 * Who may use a secret.
 *
 * - `agent:<id>` — one agent, whichever person is driving it.
 * - `principal:<id>` — any agent a given person is driving.
 * - `*` — any agent. The broadest, and the one to reach for last.
 */
export type GrantHolder = string;

export interface Grant {
  holder: GrantHolder;
  /** ISO instant after which the grant is dead. Absent means it does not expire. */
  expiresAt?: string;
}

export interface Secret {
  id: string;
  description: string;
  value: string;
  grants: Grant[];
}

/** A secret as a reader may see it: everything but the value. */
export interface SecretView {
  id: string;
  description: string;
  grants: Grant[];
}

interface VaultFile {
  secrets: Secret[];
}

export function vaultPath(): string {
  return process.env.AGENTBOX_VAULT ?? join(agentboxHome(), "vault.json");
}

export function vaultAuditPath(): string {
  return process.env.AGENTBOX_VAULT_AUDIT ?? join(agentboxHome(), "vault-audit.jsonl");
}

/** Whether a grant covers this caller right now. */
function grantCovers(
  grant: Grant,
  caller: { agentId: string; principalId?: string },
  now: number
): boolean {
  if (grant.expiresAt !== undefined) {
    const expiry = Date.parse(grant.expiresAt);
    // An unreadable expiry is treated as expired: a credential that cannot prove it is
    // still live should not be handed out on the strength of a typo.
    if (Number.isNaN(expiry) || now >= expiry) return false;
  }
  if (grant.holder === "*") return true;
  if (grant.holder === `agent:${caller.agentId}`) return true;
  if (caller.principalId !== undefined && grant.holder === `principal:${caller.principalId}`) {
    return true;
  }
  return false;
}

export class Vault {
  private secrets: Secret[] = [];

  constructor(
    private readonly path: string = vaultPath(),
    private readonly auditPath: string = vaultAuditPath()
  ) {
    this.reload();
  }

  reload(): void {
    this.secrets = [];
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as VaultFile;
      for (const raw of parsed.secrets ?? []) {
        if (typeof raw?.id !== "string" || typeof raw?.value !== "string") continue;
        this.secrets.push({
          id: raw.id,
          description: typeof raw.description === "string" ? raw.description : "",
          value: raw.value,
          grants: Array.isArray(raw.grants)
            ? raw.grants
                .filter((g): g is Grant => typeof g?.holder === "string")
                .map(g => ({
                  holder: g.holder,
                  ...(typeof g.expiresAt === "string" ? { expiresAt: g.expiresAt } : {}),
                }))
            : [],
        });
      }
    } catch {
      // A broken file is an empty vault, not a broken server: every resolve then
      // refuses, which is the safe direction for a credential store.
    }
  }

  /** Every secret, without its value. The only read path that leaves the class. */
  list(): SecretView[] {
    return this.secrets.map(secret => ({
      id: secret.id,
      description: secret.description,
      grants: secret.grants.map(grant => ({ ...grant })),
    }));
  }

  /**
   * Creates or updates a secret. A missing `value` keeps the existing one — so an
   * operator editing a description or grants does not have to re-paste the secret,
   * and the UI never has to hold a value it was never shown.
   */
  setSecret(input: { id: string; description?: string; value?: string; grants?: Grant[] }): void {
    const id = input.id.trim();
    if (id === "") return;
    const existing = this.secrets.find(secret => secret.id === id);
    if (existing === undefined && (input.value ?? "") === "") {
      // A new secret with no value is nothing to store.
      return;
    }
    const secret: Secret = {
      id,
      description: input.description ?? existing?.description ?? "",
      value: input.value !== undefined && input.value !== "" ? input.value : existing?.value ?? "",
      grants: input.grants ?? existing?.grants ?? [],
    };
    this.secrets = [...this.secrets.filter(s => s.id !== id), secret];
    this.persist();
  }

  removeSecret(id: string): void {
    this.secrets = this.secrets.filter(secret => secret.id !== id);
    this.persist();
  }

  /**
   * The value of a secret, if a live grant covers this caller — and an audit line
   * either way. Undefined means "not allowed or no such secret", said the same way so
   * a caller cannot tell a missing secret from a refused one by timing or message.
   */
  resolve(
    id: string,
    caller: { agentId: string; agentName?: string; principalId?: string },
    now: Date = new Date()
  ): string | undefined {
    const secret = this.secrets.find(s => s.id === id);
    const allowed =
      secret !== undefined &&
      secret.grants.some(grant => grantCovers(grant, caller, now.getTime()));
    this.audit({
      at: now.toISOString(),
      secretId: id,
      agentId: caller.agentId,
      ...(caller.agentName !== undefined ? { agentName: caller.agentName } : {}),
      ...(caller.principalId !== undefined ? { principalId: caller.principalId } : {}),
      allowed,
      known: secret !== undefined,
    });
    return allowed ? secret!.value : undefined;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ secrets: this.secrets }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temp, this.path);
    chmodSync(this.path, 0o600);
  }

  private audit(entry: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.auditPath), { recursive: true });
      appendFileSync(this.auditPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
      chmodSync(this.auditPath, 0o600);
    } catch {
      // An unwritable audit log must not stop a credential from being used or refused —
      // the decision is what matters and it has already been made. It is the one place
      // silence is accepted, matching the policy log's own last resort.
    }
  }
}
