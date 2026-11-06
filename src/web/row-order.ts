/**
 * The order of the agent list (INV-1626): what moved last is on top, and an agent waiting on
 * the person is above everything that merely moved. A→Z stays as the person's choice. The list
 * is the first screen, and the person arrives asking what needs them, not who exists.
 *
 * Written once as a plain function and shipped to the page as its own source (`ROW_ORDER_JS`),
 * so the test and the page run the same comparator.
 */

export interface OrderedRow {
  name: string;
  facts?: { lastActivityAt?: string; awaiting?: { since: string } };
}

/** Waiting on the person first, then the newest activity, then the name. A→Z is the name alone. */
export function rowOrder<T extends OrderedRow>(rows: readonly T[], mode: "recent" | "az"): T[] {
  const byName = (a: OrderedRow, b: OrderedRow): number => a.name.localeCompare(b.name);
  if (mode === "az") return [...rows].sort(byName);
  const moved = (row: OrderedRow): string => (row.facts && row.facts.lastActivityAt) || "";
  const waits = (row: OrderedRow): number => (row.facts && row.facts.awaiting ? 1 : 0);
  return [...rows].sort((a, b) => waits(b) - waits(a) || (moved(b) > moved(a) ? 1 : moved(b) < moved(a) ? -1 : 0) || byName(a, b));
}

/** Teams by their most recent member — the comment above the list claimed this for a year; now it is so. */
export function teamOrder<T extends OrderedRow>(groups: Record<string, readonly T[]>, mode: "recent" | "az"): string[] {
  const names = Object.keys(groups);
  if (mode === "az") return names.sort((a, b) => a.localeCompare(b));
  const newest = (team: string): string => rowOrder(groups[team] ?? [], "recent").map(row => (row.facts && row.facts.awaiting ? "~" : "") + ((row.facts && row.facts.lastActivityAt) || ""))[0] ?? "";
  return names.sort((a, b) => (newest(b) > newest(a) ? 1 : newest(b) < newest(a) ? -1 : 0) || a.localeCompare(b));
}

/** The page's copy: the two functions above, verbatim, as a classic script. */
export const ROW_ORDER_JS = `${rowOrder.toString()}\n${teamOrder.toString()}\n`;
