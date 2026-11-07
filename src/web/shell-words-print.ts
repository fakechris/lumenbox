/**
 * Prints the shell's own words (INV-1709, `src/i18n/shell-words.ts`) for the shell, which does not
 * load TypeScript itself: `shell-words-print.ts <languages> [choice]`, where languages is the
 * system's preferred list (`zh-CN,en-US`) and choice is what the person picked on the personal page
 * (the `lumen-lang` cookie), which wins. Answers `{ "locale": "zh", "words": { key: text } }` with
 * the `{blanks}` left for the shell to fill.
 */
import { pathToFileURL } from "node:url";
import { resolveLocale } from "../i18n/locale.ts";
import { tr } from "../i18n/messages.ts";
import { SHELL_WORDS } from "../i18n/shell-words.ts";

export function shellWords(languages: string | undefined, choice: string | undefined): { locale: string; words: Record<string, string> } {
  const locale = resolveLocale({ preference: choice || undefined, acceptLanguage: languages || undefined });
  return { locale, words: Object.fromEntries(Object.keys(SHELL_WORDS).map(key => [key, tr(key, locale)])) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(shellWords(process.argv[2], process.argv[3])));
}
