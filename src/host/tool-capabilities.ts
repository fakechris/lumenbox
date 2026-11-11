/** Resource requirements follow the actual tool definitions, rather than a second name list. */
import { buildTools, DESKTOP_TOOLS } from "./tools.ts";
let computerTools: ReadonlySet<string> | undefined;
export function needsComputer(name: string): boolean {
  if (!computerTools) {
    const without = new Set(buildTools(false, true, undefined, false, false).map(tool => tool.name));
    computerTools = new Set([...DESKTOP_TOOLS, ...buildTools(true, true, undefined, true, true).filter(tool => !without.has(tool.name)).map(tool => tool.name)]);
  }
  return computerTools.has(name);
}
