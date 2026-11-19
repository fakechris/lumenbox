/**
 * The model-call cache (INV-1772): a call already paid for is not paid for again.
 *
 * Keyed by the request as sent (the prompt, tools and settings), the version of the task it
 * belongs to, and the recipe — which subject, which model, which attempt. Running a report twice
 * makes no calls the second time; changing a prompt, a task or the model misses exactly the calls
 * that changed. The attempt is in the key on purpose: k attempts are k samples, and answering
 * all of them from the first would turn pass^k into pass@1 without saying so.
 *
 * One file per call under the cache directory, so a cache can be inspected, copied between
 * machines and deleted by hand. Nothing is ever evicted: an entry is only reachable by a request
 * identical to the one that made it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { canonical, digest } from "./corpus.ts";

/** One request to a model. `stream` is how a turn calls it; `create` how the one-shot callers do. */
export type ModelCall = (params: Anthropic.MessageCreateParams, wire: "create" | "stream") => Promise<Anthropic.Message>;

export interface CallCounters {
  /** Calls that reached the model in this run. */
  made: number;
  /** Calls answered from the cache. */
  cached: number;
}

/** Raised under `offline` when a call is not in the cache: the run refuses to spend rather than guess. */
export class CacheMiss extends Error {
  constructor() {
    super("not in the cache, and this run may not call the model (--offline)");
  }
}

export interface CacheStore {
  get(key: string): Anthropic.Message | undefined;
  set(key: string, message: Anthropic.Message, note: Record<string, unknown>): void;
}

export class FileCache implements CacheStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private path(key: string): string {
    return join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  get(key: string): Anthropic.Message | undefined {
    const path = this.path(key);
    if (!existsSync(path)) return undefined;
    try {
      return (JSON.parse(readFileSync(path, "utf8")) as { message: Anthropic.Message }).message;
    } catch {
      // A torn write is a miss: the call is made again and the entry rewritten whole.
      return undefined;
    }
  }

  set(key: string, message: Anthropic.Message, note: Record<string, unknown>): void {
    mkdirSync(join(this.dir, key.slice(0, 2)), { recursive: true });
    writeFileSync(this.path(key), `${JSON.stringify({ ...note, message })}\n`);
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * The request as a key. An episode mints fresh agent ids each run and names them in the prompt;
 * they are the only thing that differs between two runs of the same episode (measured: the
 * requests are otherwise byte-identical), so they are blanked before hashing.
 */
export const requestFingerprint = (params: Anthropic.MessageCreateParams): string => digest(canonical(params).replace(UUID, "<id>"));

export interface CacheScope {
  /** The task's version (corpus.ts): a task edited is a task asked again. */
  dataVersion: string;
  /** Everything else that makes two calls different samples: subject, provider, model, attempt. */
  recipe: Record<string, string | number>;
}

/**
 * Wraps a model so each call is looked up first. One wrapper per attempt: a request repeated
 * within the attempt is a second call with its own entry, not the first one again.
 */
export function cachedModel(model: ModelCall, store: CacheStore | undefined, scope: CacheScope, counters: CallCounters, options: { offline?: boolean } = {}): ModelCall {
  const seen = new Map<string, number>();
  return async (params, wire) => {
    const request = requestFingerprint(params);
    const occurrence = seen.get(request) ?? 0;
    seen.set(request, occurrence + 1);
    const key = digest(canonical({ request, data: scope.dataVersion, recipe: scope.recipe, occurrence }));
    const hit = store?.get(key);
    if (hit !== undefined) {
      counters.cached += 1;
      return hit;
    }
    if (options.offline === true) throw new CacheMiss();
    const message = await model(params, wire);
    counters.made += 1;
    store?.set(key, message, { data: scope.dataVersion, recipe: scope.recipe, request });
    return message;
  };
}
