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

export function installationRoute(route: string, deps: { principals: Principals }): { status: number; body: unknown } | undefined {
  if (route === "GET /api/installation") return { status: 200, body: { installation: deps.principals.installation() } };
  return undefined;
}

/** The status and body fields for an error a route threw: on a personal installation's refusal, 409 with the sentence, `needs` and the manual page. */
export function routeErrorReply(error: unknown, locale: Locale): { status?: number; error?: string; needs?: string; manual?: string } {
  if (!(error instanceof PersonalInstallationOnly)) return {};
  return { status: 409, error: tr(error.key, locale), needs: error.needs, manual: manualPage(PERSONAL_ONLY_PAGE, locale) };
}
