/**
 * Which language a person is spoken to in (INV-544).
 *
 * The product's market is a Chinese workplace and its chat strings were written in Chinese
 * (`channels/strings.ts`); the web UI was written in English. The same person therefore
 * read a Chinese card in Feishu and English buttons on the page — not a translation
 * problem so much as two different products wearing one name.
 *
 * One bundle, then, and one rule for choosing between its languages. The rule's order is
 * the order of how much somebody meant it:
 *
 *   1. **What this person set.** A stored preference is a decision, and it wins over
 *      everything a browser or a door guesses.
 *   2. **What their browser asks for.** `Accept-Language` is a real preference, weakly held.
 *   3. **What the door implies.** A Feishu or DingTalk room is a Chinese workplace;
 *      Telegram is not. This is a default, not a belief about the person.
 *   4. **The installation's own default**, and finally `zh`, which is what every chat
 *      string in this repository was before this file existed.
 *
 * Two languages on purpose. A third is a translation project, not a code change, and
 * pretending otherwise produces half-translated screens — which read worse than one
 * language a person does not prefer.
 */

export const LOCALES = ["zh", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "zh";

export function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && (LOCALES as readonly string[]).includes(value);
}

/** The best of what an `Accept-Language` header asks for, or undefined. */
export function localeFromAcceptLanguage(header: string | undefined): Locale | undefined {
  if (header === undefined || header.trim() === "") return undefined;
  const wanted = header
    .split(",")
    .map(part => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map(p => /^q=([0-9.]+)$/.exec(p.trim())?.[1]).find(value => value !== undefined);
      return { tag: (tag ?? "").trim().toLowerCase(), q: q === undefined ? 1 : Number(q) };
    })
    .filter(entry => entry.tag !== "" && Number.isFinite(entry.q))
    .sort((a, b) => b.q - a.q);
  for (const { tag } of wanted) {
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return undefined;
}

/** What a door implies about the room, absent anything the person said. */
export function localeOfChannel(channelType: string | undefined): Locale | undefined {
  if (channelType === undefined) return undefined;
  if (channelType === "feishu" || channelType === "dingtalk") return "zh";
  if (channelType === "telegram") return "en";
  return undefined;
}

export interface LocaleSources {
  /** What this person chose, if they chose. */
  preference?: string;
  acceptLanguage?: string;
  channelType?: string;
  installationDefault?: string;
}

export function resolveLocale(sources: LocaleSources = {}): Locale {
  if (isLocale(sources.preference)) return sources.preference;
  const asked = localeFromAcceptLanguage(sources.acceptLanguage);
  if (asked !== undefined) return asked;
  const door = localeOfChannel(sources.channelType);
  if (door !== undefined) return door;
  if (isLocale(sources.installationDefault)) return sources.installationDefault;
  return DEFAULT_LOCALE;
}
