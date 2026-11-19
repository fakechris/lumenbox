/**
 * What a consent card says about a file that is run later (INV-1861): that it will be run, and
 * by whom. The table is run-later-paths.ts; the words are in src/i18n, in both languages
 * (`ui.consent.runLater`, `ui.consent.runLaterBy.*`), because a person reads them — the verbatim
 * action under them stays as it was written, and is what the consent binds to.
 */

import { DEFAULT_LOCALE, type Locale } from "../i18n/locale.ts";
import { tr } from "../i18n/messages.ts";
import type { RunLaterFinding } from "./run-later-paths.ts";

/** "This file will be run later: <who runs it>", for a card, in one language. */
export function runLaterWords(finding: RunLaterFinding, locale: Locale = DEFAULT_LOCALE): string {
  return tr("ui.consent.runLater", locale, { path: finding.path, who: tr(`ui.consent.runLaterBy.${finding.by}`, locale) });
}

/**
 * The same finding as the phrase that follows "wants to" in the record and the attention list.
 * English like every other host-written action; a card that knows its reader says `runLaterWords`.
 */
export function runLaterAction(finding: RunLaterFinding): string {
  return `write ${finding.path}, a file that is run later: ${tr(`ui.consent.runLaterBy.${finding.by}`, "en")}`;
}
