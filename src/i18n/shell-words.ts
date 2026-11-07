/**
 * The words the desktop shell says itself rather than through a page (INV-1709): the system
 * notification for an organisation that has something waiting for the person. The shell does not
 * load TypeScript; it asks `src/web/shell-words-print.ts` for these, once per language.
 *
 * Only a name and a number: the shell reads an organisation's counts, never what they count, so a
 * notice cannot say more than how many — and it does not try.
 */

export const SHELL_WORDS: Record<string, readonly [zh: string, en: string]> = {
  "shell.organisation-needs-you.title": ["{organisation} 有 {count} 件需要你", "{organisation} has {count} waiting for you"],
  "shell.organisation-needs-you.body": ["打开 LumenBox，在 {organisation} 里查看。", "Open LumenBox to see them in {organisation}."],
};
