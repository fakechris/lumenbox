/**
 * The answers an AskUser call carried, read from whatever shape the model sent them in.
 *
 * The schema says `string[]`; models sent `{label, description}` objects, then nested
 * arrays (`[["a", ["b"]]]`), and String() of those is "[object Object]" and "a,b". One
 * reader, used by the tool when it asks and by the page when it draws the card again.
 */
/** A label from whatever shape the model sent an option in: a string, a labelled object, or a nest. */
export function optionLabel(option: unknown): string | undefined {
  if (typeof option === "string") return option.trim() === "" ? undefined : option.trim();
  if (Array.isArray(option)) {
    for (const inner of option) {
      const found = optionLabel(inner);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (option !== null && typeof option === "object") {
    const named = option as Record<string, unknown>;
    for (const key of ["label", "text", "title", "name", "item"]) {
      const found = optionLabel(named[key]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
