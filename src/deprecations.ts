/**
 * The one deprecation list (docs/106 §7, INV-2201).
 *
 * A Stable interface (docs/106 §3) leaves in two steps: it is listed here for a release line,
 * still working, and only from the line named in `removableFrom` may the code stop honouring it.
 * `scripts/surface-ratchet.mjs` (run by `npm run arch`) reads this list: a removal or a changed
 * type on the stable surface fails unless the item is here and its line has come. The start-up
 * report (`deprecationsInUse`) and the release notes read the same list, so "deprecated" is said
 * in one place.
 *
 * `item` is the item's name in `surface-baseline.json` — `config/boxImage`, `env/AGENTBOX_IMAGE`,
 * `cli/box logs/--tail`, `mcp/tool/assign_task/agent` — and covers everything under it: listing a
 * command covers its flags.
 */

export interface Deprecation {
  /** The surface item, as `surface-baseline.json` names it. */
  item: string;
  /** The release line that first said so, e.g. "0.5". */
  since: string;
  /** What to use instead, in words a person can act on; "nothing" is an answer. */
  replacement: string;
  /** The first release line that may ship without it, e.g. "0.6". */
  removableFrom: string;
}

/** Empty at 0.4: nothing on the stable list has been deprecated yet. */
export const DEPRECATIONS: readonly Deprecation[] = [];

/** "0.4.9" → "0.4": the release line a version belongs to. */
export function releaseLine(version: string): string {
  const [major = "0", minor = "0"] = version.split(".");
  return `${Number.parseInt(major, 10) || 0}.${Number.parseInt(minor, 10) || 0}`;
}

/** Orders two release lines numerically, so "0.10" is after "0.9". */
export function compareLines(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = releaseLine(a).split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = releaseLine(b).split(".").map(Number);
  return aMajor !== bMajor ? aMajor - bMajor : aMinor - bMinor;
}

/** The entry covering a surface item: the item itself, or something it is under. */
export function deprecationOf(item: string, list: readonly Deprecation[] = DEPRECATIONS): Deprecation | undefined {
  return list.find(entry => item === entry.item || item.startsWith(`${entry.item}/`));
}

/** Whether the line `version` belongs to may ship without the item. */
export function removable(entry: Deprecation, version: string): boolean {
  return compareLines(version, entry.removableFrom) >= 0;
}

/**
 * What this installation still uses that is on its way out, as sentences for the start-up
 * report: a `config.json` key that is present, an environment variable that is set. Other kinds
 * of item (a CLI flag, an MCP field) are reported where they are used, not at start.
 */
export function deprecationsInUse(used: { configKeys: readonly string[]; envNames: readonly string[] }, list: readonly Deprecation[] = DEPRECATIONS): string[] {
  const lines: string[] = [];
  for (const entry of list) {
    const [kind, name] = entry.item.split("/");
    const inUse = (kind === "config" && name !== undefined && used.configKeys.includes(name)) || (kind === "env" && name !== undefined && used.envNames.includes(name));
    if (!inUse) continue;
    const what = kind === "config" ? `config.json key "${name}"` : `environment variable ${name}`;
    lines.push(`deprecated: ${what} (since ${entry.since}) stops working in ${entry.removableFrom}. Use instead: ${entry.replacement}`);
  }
  return lines;
}
