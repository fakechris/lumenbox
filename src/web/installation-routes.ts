/**
 * What the page reads about the installation (INV-1685, docs/22 §1a), and the refusal a personal
 * installation gives every add-person act (INV-1689): 409, the sentence in the reader's language,
 * and the manual page that says how to work with others. There is no conversion route: a
 * personal installation is never turned into an organisation.
 */
import type { Locale } from "../i18n/locale.ts";
import { tr } from "../i18n/messages.ts";
import { PersonalInstallationOnly } from "../host/installation.ts";
import type { Principals } from "../host/principals.ts";
import { manualPage, PERSONAL_ONLY_PAGE } from "./manual-link.ts";
import { confirmMerge, MergeRefused, mergePreview, type MergePaths } from "../host/self-merge.ts";

export function installationRoute(route: string, deps: { principals: Principals }): { status: number; body: unknown } | undefined {
  if (route === "GET /api/installation") return { status: 200, body: { installation: deps.principals.installation() } };
  return undefined;
}

/** The status and body fields for an error a route threw: on a personal installation's refusal, 409 with the sentence, `needs` and the manual page. */
export function routeErrorReply(error: unknown, locale: Locale): { status?: number; error?: string; needs?: string; manual?: string } {
  if (!(error instanceof PersonalInstallationOnly)) return {};
  return { status: 409, error: tr(error.key, locale), needs: error.needs, manual: manualPage(PERSONAL_ONLY_PAGE, locale) };
}

/**
 * "These are all me" (INV-1698, src/host/self-merge.ts): the preview, and the confirmation that
 * writes the merge's journal. The merge itself runs at the next start, so the page restarts the
 * server after a 200. Admins only — on the desktop app, the operator holding the UI token.
 */
export async function mergeRoute(route: string, deps: {
  paths: () => MergePaths; desktop: boolean; doorType: (door: string) => string | undefined;
  refusedAdmin: () => boolean; readJson: () => Promise<Record<string, unknown>>; by: () => string; log: (line: string) => void;
}): Promise<{ status: number; body: unknown } | undefined> {
  if (route !== "GET /api/installation/merge" && route !== "POST /api/installation/merge") return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: undefined };
  if (route === "GET /api/installation/merge") return { status: 200, body: mergePreview(deps.paths(), { desktop: deps.desktop, doorType: deps.doorType }) };
  const body = await deps.readJson();
  if (body.confirm !== true || typeof body.digest !== "string") return { status: 400, body: { error: "Confirm the preview: send { confirm: true, digest } from GET /api/installation/merge." } };
  try {
    const journal = confirmMerge(deps.paths(), { digest: body.digest, ...(typeof body.name === "string" ? { name: body.name } : {}), by: deps.by(), desktop: deps.desktop });
    deps.log(`installation: ${journal.from.length} people confirmed to be one person by ${journal.by}; they are merged into the Owner "${journal.name}" at the next start (INV-1698)`);
    return { status: 200, body: { state: journal.state, name: journal.name, people: journal.from.length, restartNeeded: true } };
  } catch (error) {
    if (error instanceof MergeRefused) return { status: 409, body: { error: error.message, why: error.why } };
    throw error;
  }
}
