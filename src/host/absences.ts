/**
 * What this installation is missing, said once, out loud, at startup.
 *
 * Three capabilities were found present in the source and absent at runtime, each by
 * accident (docs/14): the search tool refusing every call for a key nobody set, delegated
 * engines starting with no credential because nothing sets the relay variables, and a
 * starter skill that could never reach an existing box. The instances differ; the class
 * is one thing — **a capability that degrades silently reads as covered until somebody
 * traces a failure back to it.** The search key was found because an agent walked into a
 * captcha; the relay because a document claimed metering that could not happen; the skill
 * because a count came up one short. None of those is a discovery mechanism.
 *
 * So this is the discovery mechanism: state what the source expects, compare it to what
 * the installation has, and name each gap with its consequence and its one-line remedy.
 * The same argument the box preflight makes, applied to the host's own configuration.
 *
 * Pure on purpose — reads an environment, returns findings, prints nothing — so a test
 * can hand it environments that took days to stumble into.
 */

import { SEARCH_KEY_VARIABLE } from "./web.ts";
import { RELAY_TOKEN_VARIABLE, RELAY_URL_VARIABLE } from "./presets.ts";

export interface Absence {
  /** The capability as a person would name it. */
  capability: string;
  /** What actually happens while it is missing — the degradation, not just "unset". */
  detail: string;
  /** The one-line fix. */
  remedy: string;
}

export function absences(env: NodeJS.ProcessEnv = process.env): Absence[] {
  const found: Absence[] = [];

  if (env[SEARCH_KEY_VARIABLE] === undefined || env[SEARCH_KEY_VARIABLE] === "") {
    found.push({
      capability: "web search",
      detail:
        "WebSearch refuses every call, so web questions degrade to scraping a search " +
        "engine through the browser — which answers with a page, not an error.",
      remedy: `set env.${SEARCH_KEY_VARIABLE} in config.json`,
    });
  }

  const url = env[RELAY_URL_VARIABLE];
  const token = env[RELAY_TOKEN_VARIABLE];
  if (url === undefined || url === "" || token === undefined || token === "") {
    found.push({
      capability: "delegated engines",
      detail:
        "Delegate starts a preset engine with no model credential — the vault is right " +
        "not to hand it ours — so every delegated run fails at its first request.",
      remedy: `set ${RELAY_URL_VARIABLE} and ${RELAY_TOKEN_VARIABLE}, or avoid Delegate`,
    });
  }

  return found;
}

/** The findings as printable lines, empty when there is nothing to say. */
export function describeAbsences(env: NodeJS.ProcessEnv = process.env): string[] {
  return absences(env).map(
    absence => `missing: ${absence.capability} — ${absence.detail} Fix: ${absence.remedy}.`
  );
}
