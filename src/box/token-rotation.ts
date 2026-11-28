/**
 * Changing a box's token without re-attaching it and without stopping its agents (docs/106 §5 R7).
 *
 * The box accepts tokens in two steps (src/boxd/token-store.ts), and the host does its half in the
 * order that leaves no moment at which the token it holds is one the box refuses:
 *
 * 1. a new token is minted and written beside the old file as `<file>.next`;
 * 2. the box is asked, with the current token, to accept it too (`/token/rotate`) — from here on
 *    both work, across a restart of either side;
 * 3. `<file>.next` is renamed over the token file (one atomic step) and the live client switches;
 * 4. the box is asked, with the new token, to make it the token (`/token/confirm`): the old one
 *    then works for `TOKEN_OVERLAP_SECONDS` more and stops.
 *
 * A failure before step 2 changes nothing. A failure after it leaves the box accepting both until
 * the next rotation confirms one, which the answer says. A box whose daemon predates rotation answers
 * step 2 with 404, and is told to be re-created from the current image.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { BoxError } from "./client.ts";

/** How long a rotated-out token keeps working: requests already on their way, and processes still holding the old file. */
export const TOKEN_OVERLAP_SECONDS = 5 * 60;

/** What a rotation needs of the connection to a box: the box client's three token calls. */
export interface RotatableBox {
  rotateToken(next: string): Promise<void>;
  useToken(next: string): void;
  confirmToken(overlapSeconds: number): Promise<{ overlap_until?: string; overlapUntil?: string }>;
}

export class BoxTokenRotationRefused extends Error {}

export interface RotationResult {
  /** Until when the old token still works; absent when the box could not be told to switch yet. */
  overlapUntil?: string;
  confirmed: boolean;
}

/**
 * Rotates the token of the box `box` reaches, whose token the host keeps in `tokenFile`.
 * `alsoUse` is told the new token once it is saved: every other holder of a live connection
 * (the provisioner that hands out the own box's address). Never logs or returns the token.
 */
export async function rotateBoxToken(input: { box: RotatableBox; tokenFile: string; label: string; alsoUse?: (next: string) => void; overlapSeconds?: number }): Promise<RotationResult> {
  const next = randomBytes(32).toString("hex");
  const pending = `${input.tokenFile}.next`;
  writeFileSync(pending, `${next}\n`, { mode: 0o600 });
  try {
    await input.box.rotateToken(next);
  } catch (error) {
    rmSync(pending, { force: true });
    if (error instanceof BoxError && error.status === 404) {
      throw new BoxTokenRotationRefused(`${input.label} runs a box daemon from before token rotation. Re-create it from the current image (\`agentbox box up --recreate\` for this machine's box), then rotate.`);
    }
    throw new BoxTokenRotationRefused(`${input.label}: the box did not take a new token, so nothing changed. ${error instanceof Error ? error.message : String(error)}`);
  }
  renameSync(pending, input.tokenFile);
  chmodSync(input.tokenFile, 0o600);
  input.box.useToken(next);
  input.alsoUse?.(next);
  try {
    const answer = await input.box.confirmToken(input.overlapSeconds ?? TOKEN_OVERLAP_SECONDS);
    const overlapUntil = answer.overlapUntil ?? answer.overlap_until;
    return { confirmed: true, ...(overlapUntil !== undefined ? { overlapUntil } : {}) };
  } catch {
    // The box accepts the old and the new token until a rotation is confirmed; the host holds the new one.
    return { confirmed: false };
  }
}
