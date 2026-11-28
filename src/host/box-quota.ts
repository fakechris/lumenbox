/**
 * How many personal boxes a person may hold (docs/36 §5, the owner's ruling
 * of 2026-09-03: configuration, not a constant).
 *
 * The installation default is `0` or `1` (or more, for a company that means
 * it); a department refines it — 客服部 sharing machines gets `0`, engineering
 * gets `1` — and a person is the exception that outranks both. Resolution is
 * one chain, asked in one direction: **person → department → installation**,
 * first answer wins. A department-wide `0` is a real ceiling and a per-person
 * `1` is a real exception, because the same order reads them both.
 *
 * What a personal box *is*: a box whose members list exactly one principal
 * (docs/18's ruling — invisible to everyone else, which stage 3's no-leak
 * listings already make true). Counting them is asking which boxes are
 * somebody's, and the answer is structural, not a label.
 */

import type { BoxEntry } from "../box/boxes.ts";

export interface QuotaSources {
  /** The installation's default; the personal product ships `1`. */
  installationDefault: number;
  /** Per department, keyed `<channelId>:<departmentVendorId>`. */
  departmentQuotas: Record<string, number>;
  /** Per person, keyed principal id. */
  personQuotas: Record<string, number>;
}

export interface QuotaAnswer {
  quota: number;
  /** Where the answer came from — the admin surface says so, the refusal too. */
  from: "person" | "department" | "installation";
}

/**
 * The chain. Departments arrive as the keys the directory knows a person by
 * (`<channelId>:<vendorId>`); the first department with a quota answers,
 * which keeps one department's `0` from being silently rescued by another's
 * `1` — the order among a person's departments is the directory's own.
 */
export function personalQuotaFor(
  principalId: string,
  departments: string[] | undefined,
  sources: QuotaSources,
): QuotaAnswer {
  const person = sources.personQuotas[principalId];
  if (person !== undefined) return { quota: person, from: "person" };
  for (const department of departments ?? []) {
    const quota = sources.departmentQuotas[department];
    if (quota !== undefined) return { quota, from: "department" };
  }
  return { quota: sources.installationDefault, from: "installation" };
}

/** The boxes that are exactly one person's — membership as the definition, not a label. */
export function personalBoxesOf(entries: readonly BoxEntry[], principalId: string): BoxEntry[] {
  return entries.filter(
    entry => entry.members.kind === "listed" && entry.members.principalIds.length === 1 && entry.members.principalIds[0] === principalId,
  );
}

/** A box name safe on a path, a command line, and a container: `p-` and the id, slugged. */
export function personalBoxName(principalId: string): string {
  const slug = principalId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `p-${slug === "" ? "member" : slug}`;
}
