/** For a settled call that neither a parked turn nor an extension will execute. */
export function approvedCallNotice(description: string, scope: "once" | "session" | "always"): string {
  const duration = scope === "once" ? " once" : scope === "session" ? " for this session" : ", standing until revoked";
  return `[The person allowed it${duration}: ${description}. The call was NOT executed. ` +
    "Make the same call again now; it will go through without asking again.]";
}
