/**
 * Puts each value in its blank (`{name}`), for the server's words and both pages' (INV-2311).
 *
 * Chinese sets no space around a Chinese name in a Chinese sentence ("和助手对话"), and sets one
 * around a Latin word or a number ("和 Ada 对话", "3 个"). The templates are written with no space
 * beside a blank, and the space is decided here, by what is put in it. Shipped to the pages as its
 * own source, so the server and the pages fill alike.
 */
export function fillWords(text: string, vars: Record<string, unknown> | undefined): string {
  return text.replace(/\{(\w+)\}/g, (whole: string, name: string, at: number, all: string) => {
    if (!vars || vars[name] === undefined || vars[name] === null) return whole;
    const value = String(vars[name]), chinese = /[㐀-鿿]/, latin = /[!-~]/; // a Latin word, a number, a path
    const before = chinese.test(all.charAt(at - 1)) && latin.test(value.charAt(0)) ? " " : "";
    const after = chinese.test(all.charAt(at + whole.length)) && latin.test(value.charAt(value.length - 1)) ? " " : "";
    return before + value + after;
  });
}

/** The same function, as page source. */
export const FILL_WORDS_JS = fillWords.toString();
