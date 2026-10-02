import { createHash } from "node:crypto";

/** A box-observed disclosure, revalidated at the executor before using consent. */
export interface SensitiveInput {
  origin: string;
  category: string;
  valueHash: string;
}

export interface SensitiveInputApproval extends SensitiveInput { expiresAt: number; }
export const SENSITIVE_INPUT_TTL_MS = 15 * 60_000;

export function inputValueHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function parseSensitiveInput(value: unknown): SensitiveInput | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Partial<SensitiveInput>;
  if (typeof v.origin !== "string" || typeof v.category !== "string" || v.category.length === 0 || v.category.length > 80 ||
      typeof v.valueHash !== "string" || !/^[a-f0-9]{64}$/.test(v.valueHash)) return undefined;
  try {
    const url = new URL(v.origin);
    if (!["https:", "http:"].includes(url.protocol) || url.origin !== v.origin) return undefined;
  } catch { return undefined; }
  return { origin: v.origin, category: v.category, valueHash: v.valueHash };
}

export function sameSensitiveInput(a: SensitiveInput, b: SensitiveInput): boolean {
  return a.origin === b.origin && a.category === b.category && a.valueHash === b.valueHash;
}
