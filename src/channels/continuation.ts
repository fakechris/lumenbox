/** Intent is not ownership. Only an explicit task/question reference can join work. */
export function parseContinuation(text: string): { kind: "continue" | "answer"; id: string; text: string } | undefined {
  const match = /^\/(continue|answer)\s+([A-Za-z0-9_-]+)\s+([\s\S]*\S)\s*$/u.exec(text.trim());
  if (match === null) return undefined;
  return { kind: match[1] as "continue" | "answer", id: match[2]!, text: match[3]! };
}
