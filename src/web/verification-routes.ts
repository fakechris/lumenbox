/**
 * A verification report's routes (INV-1925): `GET /verification/<id>` (the page),
 * `GET /verification/<id>/video` (its recording) and `GET /api/verification/<id>` (the data).
 * Judged like the recording routes (INV-1949): a report of a member the caller may not enter is
 * refused, and the video comes from that member's own box.
 */

import type { ServerResponse } from "node:http";
import { reportCounts, type VerificationReports } from "../host/verification-report.ts";
import { apiError } from "./api-error.ts";
import { verificationPageHtml } from "./verification-page.ts";

export interface VerificationRouteDeps {
  reports: VerificationReports | undefined;
  mayReadAgent: (agentId: string) => boolean;
  send: (res: ServerResponse, status: number, body: unknown, type?: string) => void;
  /** Streams a recording from the member's own box. */
  proxyVideo: (agentId: string, file: string) => Promise<void>;
}

/** Answers true when the route was one of these. */
export async function verificationRoute(route: string, res: ServerResponse, deps: VerificationRouteDeps): Promise<boolean> {
  const match = /^GET \/(api\/)?verification\/(vr-[a-f0-9]{8})(\/video)?$/.exec(route);
  if (!match || (match[1] && match[3])) return false;
  const report = deps.reports?.get(match[2]!);
  if (report === undefined) { deps.send(res, 404, apiError("verification-unknown")); return true; }
  if (!deps.mayReadAgent(report.agentId)) { deps.send(res, 403, apiError("box-not-yours")); return true; }
  if (match[1]) deps.send(res, 200, { report, counts: reportCounts(report) });
  else if (!match[3]) deps.send(res, 200, verificationPageHtml(report), "text/html; charset=utf-8");
  else if (report.recording === undefined) deps.send(res, 404, apiError("verification-no-recording"));
  else await deps.proxyVideo(report.agentId, report.recording.file);
  return true;
}
