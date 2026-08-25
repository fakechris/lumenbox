/**
 * A Scope: the authority an agent has, as one named object instead of five settings.
 *
 * An agent's power was scattered — a tool allowlist on its profile, secret grants in
 * the vault, an egress list on the relay, a work directory in the box — and lining
 * them up by hand for "this agent, on the vendor project" was five edits that could
 * disagree. A Scope binds them: name it once, place agents in it, and adding a secret
 * or narrowing the tools moves everyone in the scope together. Removing an agent from
 * a scope revokes all of it at once.
 *
 * This is the Grant object grown up. A grant answered "may this holder use this one
 * secret"; a Scope answers "what may an agent in this project reach at all", and a
 * secret grant becomes one line of it (`secretIds`). The vault still owns secret
 * *values* and their audit; the Scope owns *authorization* and nothing reads a value
 * through it.
 *
 * What it confers, and how much is enforced today:
 *
 *   - **tools** — enforced now. A scoped agent's offered tools are the scope's list;
 *     it replaces the profile's own, because an agent in a scope is defined by the
 *     scope, not by settings that might contradict it.
 *   - **secrets** — enforced now. `RunOnHost` resolves a secret if the caller's scope
 *     lists it, audited as a scope grant, exactly as a direct vault grant is.
 *   - **egressHosts, filesRoot** — declared now, enforced later. The relay's allow
 *     list and the box's work directory are global infrastructure; making them
 *     per-scope needs box-protocol work that is its own change. The fields are here so
 *     that work has a place to read from and no migration when it lands.
 *
 * ~/.agentbox/scopes.json, 0600 because it names secrets and is the access-control
 * shape. Same reload-on-edit and safe-defaults discipline as principals.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";

export interface Scope {
  id: string;
  name: string;
  /** The tools an agent in this scope may use. Absent means "no narrowing" — the profile's own. */
  tools?: string[];
  /** Vault secret ids this scope grants. Resolution still goes through the vault. */
  secretIds: string[];
  /** Egress hosts this scope's agents may reach. Declared; relay enforcement is a later change. */
  egressHosts?: string[];
  /** The work directory this scope confines to. Declared; box enforcement is a later change. */
  filesRoot?: string;
  /**
   * Chats bound to this scope, as chatKeys ("feishu:oc_x"). A bound chat's turns are
   * *narrowed* by the scope's tools — an intersection with the agent's own, never a
   * grant: the room's authority bounds the work, it does not hand an agent tools its
   * own definition withheld. Secrets and egress follow the same declared-then-enforced
   * path as the fields above.
   */
  chats?: string[];
}

/**
 * The tools a turn may offer: the agent's own, bounded by the chat's scope when one
 * is bound. Undefined means "no narrowing" on either side, which is why the both-
 * undefined case stays undefined rather than becoming an empty list.
 */
export function narrowTools(
  own: readonly string[] | undefined,
  chat: readonly string[] | undefined
): string[] | undefined {
  if (chat === undefined) return own === undefined ? undefined : [...own];
  if (own === undefined) return [...chat];
  return own.filter(tool => chat.includes(tool));
}

interface ScopesFile {
  scopes: Scope[];
}

export function scopesPath(): string {
  return process.env.AGENTBOX_SCOPES ?? join(agentboxHome(), "scopes.json");
}

export class ScopeStore {
  private scopes = new Map<string, Scope>();

  constructor(private readonly path: string = scopesPath()) {
    this.reload();
  }

  reload(): void {
    this.scopes.clear();
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as ScopesFile;
      for (const raw of parsed.scopes ?? []) {
        if (typeof raw?.id !== "string" || typeof raw?.name !== "string") continue;
        this.scopes.set(raw.id, {
          id: raw.id,
          name: raw.name,
          ...(Array.isArray(raw.tools) ? { tools: raw.tools.filter(t => typeof t === "string") } : {}),
          secretIds: Array.isArray(raw.secretIds)
            ? raw.secretIds.filter((s): s is string => typeof s === "string")
            : [],
          ...(Array.isArray(raw.egressHosts)
            ? { egressHosts: raw.egressHosts.filter((h): h is string => typeof h === "string") }
            : {}),
          ...(typeof raw.filesRoot === "string" && raw.filesRoot !== ""
            ? { filesRoot: raw.filesRoot }
            : {}),
          ...(Array.isArray(raw.chats)
            ? { chats: raw.chats.filter((c): c is string => typeof c === "string") }
            : {}),
        });
      }
    } catch {
      // A broken file is no scopes, not a broken server: every scoped agent then falls
      // back to its own profile, which is the pre-scope behaviour.
    }
  }

  list(): Scope[] {
    return [...this.scopes.values()].map(scope => ({
      ...scope,
      ...(scope.tools ? { tools: [...scope.tools] } : {}),
      secretIds: [...scope.secretIds],
      ...(scope.egressHosts ? { egressHosts: [...scope.egressHosts] } : {}),
      ...(scope.chats ? { chats: [...scope.chats] } : {}),
    }));
  }

  /**
   * The scope bound to a chat's conversation, if any. `normalize` maps a stored
   * chatKey to a conversation id, because the two spell the same chat differently
   * (a conversation id is filename-safe) and the caller owns that mapping.
   */
  boundTo(conversation: string, normalize: (chatKey: string) => string): Scope | undefined {
    for (const scope of this.scopes.values()) {
      // Prefix, not equality. A conversation is keyed on the thread now, so a scope bound
      // to a chat must still bound every thread inside it — an exact match would silently
      // unbind every room the moment threads started their own conversations.
      if (
        (scope.chats ?? []).some(chatKey => {
          const bound = normalize(chatKey);
          return conversation === bound || conversation.startsWith(`${bound}-`);
        })
      ) {
        return this.get(scope.id);
      }
    }
    return undefined;
  }

  get(id: string | undefined): Scope | undefined {
    if (id === undefined) return undefined;
    const scope = this.scopes.get(id);
    return scope === undefined ? undefined : { ...scope, secretIds: [...scope.secretIds] };
  }

  /** Whether this scope grants a secret — the vault consults this on resolve. */
  grantsSecret(scopeId: string | undefined, secretId: string): boolean {
    if (scopeId === undefined) return false;
    return this.scopes.get(scopeId)?.secretIds.includes(secretId) ?? false;
  }

  /** Replaces the whole set. The settings dialog's save. */
  save(scopes: Scope[]): void {
    const cleaned = scopes
      .filter(scope => scope.name.trim() !== "")
      .map(scope => ({
        id: scope.id !== "" ? scope.id : scope.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        name: scope.name.trim(),
        ...(scope.tools && scope.tools.length > 0 ? { tools: [...new Set(scope.tools)] } : {}),
        secretIds: [...new Set(scope.secretIds.filter(Boolean))],
        ...(scope.egressHosts && scope.egressHosts.length > 0
          ? { egressHosts: [...new Set(scope.egressHosts)] }
          : {}),
        ...(scope.filesRoot ? { filesRoot: scope.filesRoot } : {}),
        ...(scope.chats && scope.chats.length > 0 ? { chats: [...new Set(scope.chats)] } : {}),
      }));
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ scopes: cleaned }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temp, this.path);
    chmodSync(this.path, 0o600);
    this.reload();
  }
}
