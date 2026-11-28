/**
 * The token the box daemon accepts, and how it changes without a restart (docs/106 §5 R7, INV-2204).
 *
 * The daemon's token used to be `BOXD_TOKEN`, read once at boot: changing it meant re-creating the
 * container, re-applying a Kubernetes Secret and restarting the pod, or re-attaching a box somebody
 * else runs — and the agents' work stopped with it. Now the host can change it in two steps, so
 * that no crash on either side, at any moment, leaves the host holding a token the box refuses:
 *
 * 1. `POST /token/rotate` with the current token, naming the next one. From then on the box
 *    accepts both, for as long as it takes — across a restart too.
 * 2. `POST /token/confirm` with the next one, once the host has saved it. It becomes the token, and
 *    the old one keeps working for `TOKEN_OVERLAP_MS` so that requests already on their way, and
 *    any other process on the host still holding the old file, finish; after that it opens nothing.
 *
 * **Across a restart.** What the box accepts is written to `stateFile` (mode 0600, in the box's
 * config volume, which outlives the container) with a digest of the boot token it replaced. On the
 * next start the file is used only while `BOXD_TOKEN` is still that boot token: an operator who sets
 * a new `BOXD_TOKEN` on purpose (`box attach --replace` with a fresh token, a re-created Secret) is
 * obeyed and the file is discarded. A restart during the overlap drops the old token — the overlap
 * is for requests in flight, which a restart has ended anyway.
 *
 * Inside the box this is no new exposure: an agent with a shell can already read `BOXD_TOKEN` from
 * the daemon's environment. The box is one trust boundary (docs/03).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** How long the token a rotation replaced keeps working. */
export const TOKEN_OVERLAP_MS = 5 * 60_000;
/** The shortest token the daemon takes, the same floor as at boot. */
export const MIN_TOKEN_LENGTH = 16;

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function same(presented: string, expected: string): boolean {
  const a = Buffer.from(presented), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface Persisted { token: string; pending?: string; base: string; rotatedAt: string }

export class BoxdTokens {
  private current: string;
  /** Named by a rotation and not yet confirmed: accepted beside the current one, for as long as it takes. */
  private pending: string | undefined;
  private previous: { token: string; until: number } | undefined;
  private readonly base: string;

  constructor(
    bootToken: string,
    private readonly stateFile: string | undefined,
    private readonly now: () => number = () => Date.now(),
    private readonly log: (line: string) => void = () => {},
  ) {
    this.base = digest(bootToken);
    this.current = bootToken;
    if (stateFile === undefined || !existsSync(stateFile)) return;
    try {
      const saved = JSON.parse(readFileSync(stateFile, "utf8")) as Partial<Persisted>;
      if (saved.base === this.base && typeof saved.token === "string" && saved.token.length >= MIN_TOKEN_LENGTH) {
        this.current = saved.token;
        if (typeof saved.pending === "string" && saved.pending.length >= MIN_TOKEN_LENGTH) this.pending = saved.pending;
        log(`token: using the token rotated in at ${saved.rotatedAt ?? "an earlier start"}${this.pending !== undefined ? ", and the one a rotation named and has not confirmed" : ""} (BOXD_TOKEN is still the one it replaced)`);
        return;
      }
      // BOXD_TOKEN was changed on purpose since the rotation: that is the operator's word, and it wins.
      rmSync(stateFile, { force: true });
      log("token: BOXD_TOKEN changed since the last rotation; using it and forgetting the rotated one");
    } catch {
      log(`token: ${stateFile} could not be read; using BOXD_TOKEN`);
    }
  }

  /** Whether `presented` opens the daemon now: the current token, one a rotation named, or the one a confirmed rotation replaced while its overlap lasts. */
  accepts(presented: string): boolean {
    if (same(presented, this.current)) return true;
    if (this.pending !== undefined && same(presented, this.pending)) return true;
    if (this.previous === undefined) return false;
    if (this.now() >= this.previous.until) { this.previous = undefined; return false; }
    return same(presented, this.previous.token);
  }

  /** Whether `presented` is the current token: a rotation must be asked for with it, not with one on its way out. */
  isCurrent(presented: string): boolean {
    return same(presented, this.current);
  }

  /** Whether `presented` is the token a rotation named: only it can confirm the rotation. */
  isPending(presented: string): boolean {
    return this.pending !== undefined && same(presented, this.pending);
  }

  /** Step one: names `next`, which is accepted from now on beside the current token. A second rotation replaces an unconfirmed first. */
  rotate(next: string): { pending: true } {
    if (typeof next !== "string" || next.length < MIN_TOKEN_LENGTH || /\s/.test(next)) {
      throw new Error(`a new token is at least ${MIN_TOKEN_LENGTH} characters with no whitespace`);
    }
    if (same(next, this.current)) throw new Error("the new token is the current one");
    this.pending = next;
    this.save();
    this.log("token: a rotation named a new token; both are accepted until it is confirmed");
    return { pending: true };
  }

  /** Step two, asked for with the new token: it becomes the token, and the old one works for `overlapMs` more. */
  confirm(overlapMs = TOKEN_OVERLAP_MS): { overlapUntil: string } {
    if (this.pending === undefined) throw new Error("no rotation is waiting to be confirmed");
    const until = this.now() + Math.max(0, Math.min(overlapMs, 60 * 60_000));
    this.previous = { token: this.current, until };
    this.current = this.pending;
    this.pending = undefined;
    this.save();
    this.log(`token: rotation confirmed; the previous token works until ${new Date(until).toISOString()}`);
    return { overlapUntil: new Date(until).toISOString() };
  }

  /** The daemon's two routes, answered: named with the current token, confirmed with the new one. */
  answer(route: string, presented: string, body: unknown): { status: number; body: unknown } {
    const rotating = route === "POST /token/rotate";
    if (rotating ? !this.isCurrent(presented) : !this.isPending(presented)) {
      return { status: 409, body: { error: rotating ? "Rotate with the current token; this one is being replaced." : "Confirm with the token the rotation named." } };
    }
    const fields = (body ?? {}) as { token?: unknown; overlap_seconds?: unknown };
    try {
      return { status: 200, body: rotating ? this.rotate(String(fields.token ?? "")) : this.confirm(typeof fields.overlap_seconds === "number" ? fields.overlap_seconds * 1000 : undefined) };
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  }

  private save(): void {
    if (this.stateFile === undefined) return;
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    const saved: Persisted = { token: this.current, ...(this.pending !== undefined ? { pending: this.pending } : {}), base: this.base, rotatedAt: new Date(this.now()).toISOString() };
    writeFileSync(temp, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
    renameSync(temp, this.stateFile);
    chmodSync(this.stateFile, 0o600);
  }
}
