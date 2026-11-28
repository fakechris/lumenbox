/** A stored time as v1 writes times: RFC 3339, UTC, to the second (a fraction is what the generated Swift client cannot read). */
export function apiTime(stored: string): string {
  return new Date(stored).toISOString().replace(/\.\d{3}Z$/, "Z");
}
