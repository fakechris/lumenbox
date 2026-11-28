/**
 * `POST /api/boxes/rotate-token` — an Admin changes a box's token from the page or the CLI
 * (docs/106 §5 R7, INV-2204). The box keeps running, its agents keep working, and nothing is
 * re-attached: the two steps in src/box/token-rotation.ts.
 *
 * Which file holds a box's token depends on the box: this machine's own Docker box,
 * `<home>/tokens/<container>`; a personal box, `<home>/…/<id>.token`; an attached box, the file it
 * was attached with. Where the token comes from the environment instead (`AGENTBOX_TOKEN`) a
 * rotation could not outlive this process, so it is refused with that said.
 */
import { resolve, sep } from "node:path";
import type { BoxEntry } from "../box/boxes.ts";
import { BoxTokenRotationRefused, rotateBoxToken, type RotatableBox } from "../box/token-rotation.ts";
import type { TokenRecord } from "./token-ledger.ts";
import { apiError } from "./api-error.ts";

export interface BoxTokenRouteDeps {
  boxes: () => readonly BoxEntry[];
  ownBoxId: string;
  clientFor: (boxId: string) => RotatableBox | undefined;
  /**
   * This machine's own box's provisioner. A Docker one keeps the token in a file (or says the
   * environment supplies it) and hands out the box's address with it; any other kind cannot rotate.
   */
  provisioner: { kind: string; tokenFile?(): string | undefined; useToken?(next: string): void };
  /** Where a box keeps another copy of its token to start from — a Kubernetes personal box's Secret — the step that re-writes it (`PersonalBoxes.tokenKeeper`). */
  keeperOf?: (boxId: string) => (() => Promise<void>) | undefined;
  /** The installation's home: a token file outside it is a copy somebody else may also hold. */
  home: string;
  readJson: () => Promise<Record<string, unknown>>;
  /** True when it has already answered: only an Admin rotates. */
  refusedAdmin: () => boolean;
  by: () => string;
  record: (record: TokenRecord) => void;
  log: (line: string) => void;
}

export async function boxTokenRoute(route: string, deps: BoxTokenRouteDeps): Promise<{ status: number; body: unknown } | undefined> {
  if (route !== "POST /api/boxes/rotate-token") return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: undefined };
  const body = await deps.readJson();
  const wanted = String(body.box ?? "").trim();
  const entry = deps.boxes().find(candidate => candidate.id === wanted || candidate.name === wanted);
  if (entry === undefined) return { status: 404, body: apiError("box-named-unknown", { name: wanted || "(nothing)" }) };
  const own = entry.id === deps.ownBoxId;
  const ownBox = deps.provisioner.kind === "docker" && typeof deps.provisioner.tokenFile === "function" ? deps.provisioner : undefined;
  const tokenFile = own ? ownBox?.tokenFile?.() : entry.endpoint?.tokenFile || undefined;
  const at = new Date().toISOString(), by = deps.by();
  const refuse = (status: number, reason: string) => {
    deps.record({ at, event: "rotation-refused", kind: "box", box: entry.id, boxName: entry.name, by, reason });
    return { status, body: { error: reason } };
  };
  if (tokenFile === undefined || tokenFile === "") {
    return refuse(409, own
      ? `${entry.name}'s token comes from AGENTBOX_TOKEN, not a file this installation keeps, so a new one would not outlast this process. Unset it to let the installation keep the box's token, then rotate.`
      : `${entry.name} has no token file this installation keeps.`);
  }
  const client = deps.clientFor(entry.id);
  if (client === undefined) return refuse(409, `${entry.name} is not connected. A box's token is changed with the box: connect it first.`);
  try {
    const afterSave = own ? undefined : deps.keeperOf?.(entry.id);
    const result = await rotateBoxToken({ box: client, tokenFile, label: entry.name, ...(own && ownBox !== undefined ? { alsoUse: (next: string) => ownBox.useToken?.(next) } : {}), ...(afterSave !== undefined ? { afterSave } : {}) });
    if (result.notKept !== undefined) deps.log(`boxes: ${entry.name}'s new token is saved but what its pod is started from was not updated: ${result.notKept}`);
    deps.record({ at, event: "rotated", kind: "box", box: entry.id, boxName: entry.name, by, confirmed: result.confirmed, ...(result.overlapUntil !== undefined ? { overlapUntil: result.overlapUntil } : {}) });
    deps.log(`boxes: ${entry.name}'s token rotated by ${by}${result.confirmed ? `; the old one works until ${result.overlapUntil ?? "the overlap ends"}` : "; the box accepts both until the next rotation confirms one"}`);
    const outside = !resolve(tokenFile).startsWith(resolve(deps.home) + sep);
    return {
      status: 200,
      body: {
        rotated: entry.id,
        confirmed: result.confirmed,
        ...(result.overlapUntil !== undefined ? { overlapUntil: result.overlapUntil } : {}),
        note: [
          result.confirmed
            ? `${entry.name} has a new token. The old one keeps working until ${result.overlapUntil ?? "the overlap ends"} for requests already on their way, then opens nothing.`
            : `${entry.name} accepted the new token but could not be told to drop the old one yet; it accepts both until the next rotation.`,
          ...(result.notKept !== undefined
            ? [`What ${entry.name} is started from was not updated (${result.notKept}); it still starts with the new token, and the next start of it from this installation writes it again.`]
            : []),
          ...(entry.kind !== "docker" && outside
            ? [`The new token is in ${tokenFile}. Any other copy of the old one — including what that machine's BOXD_TOKEN is set from — no longer opens the box: ` +
                "to attach it from anywhere else, use this file, or set a new BOXD_TOKEN there and re-attach with --replace."]
            : []),
        ].join(" "),
      },
    };
  } catch (error) {
    return refuse(error instanceof BoxTokenRotationRefused ? 409 : 502, error instanceof Error ? error.message : String(error));
  }
}
