/**
 * The calibration page's two routes (INV-1773), on Settings → Supervision.
 *
 * `GET /api/calibration` — every judge's standing (judge-calibration.ts) and a sheet of the latest
 * verdicts nobody has labelled (judge-sheet.ts). `POST /api/calibration/label` — one yes or no,
 * signed by the person pressing it, appended to `~/.agentbox/judge-labels.jsonl`. Both are an
 * admin's: the sheet shows people's conversations from every box the caller may read, and a label
 * can take a judge's gate away.
 */

import type { AgentRegistry } from "../agents/registry.ts";
import { judgeBooks, appendProductLabel, readProductLabels } from "../host/judge-calibration.ts";
import { QUESTIONS, readVerdicts } from "../host/judge-record.ts";
import { buildSheet, labelsAVerdict } from "../host/judge-sheet.ts";
import { apiError } from "./api-error.ts";

/** How many verdicts one sheet asks about. */
export const SHEET_SIZE = 10;

export interface CalibrationRouteDeps {
  home: string;
  registry: AgentRegistry;
  readJson: () => Promise<Record<string, unknown>>;
  /** True when the caller is not an admin; the refusal has then been sent. */
  refusedAdmin: () => boolean;
  mayReadAgent: (agentId: string) => boolean;
  /** Who is labelling, by the name a label is signed with. */
  labeller: () => string;
  now?: () => Date;
}

export async function calibrationRoute(route: string, deps: CalibrationRouteDeps): Promise<{ status: number; body: unknown } | undefined> {
  if (route !== "GET /api/calibration" && route !== "POST /api/calibration/label") return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: null };
  const books = judgeBooks(deps.home);
  if (route === "GET /api/calibration") {
    const verdicts = readVerdicts(deps.home);
    const standings = books.standings();
    let labels: ReturnType<typeof readProductLabels> = [];
    try { labels = readProductLabels(deps.home); } catch { /* the standing says why */ }
    const sheet = buildSheet(deps.home, deps.registry, { count: SHEET_SIZE, labels, mayRead: deps.mayReadAgent, verdicts });
    return {
      status: 200,
      body: {
        labels: standings.labels, ...(standings.problem !== undefined ? { problem: standings.problem } : {}),
        judges: standings.judges.map(judge => ({
          judge: judge.judge, verdicts: judge.verdicts, versions: judge.versions, calibrated: judge.calibration.calibrated, matched: judge.calibration.matched,
          questions: judge.calibration.questions.map(one => ({ ...one, dimension: QUESTIONS[one.question]?.dimension ?? "" })),
        })),
        sheet,
      },
    };
  }
  const body = await deps.readJson();
  const question = String(body.question ?? ""), digest = String(body.digest ?? ""), label = body.label;
  if ((label !== "present" && label !== "absent") || !labelsAVerdict(deps.home, question, digest)) return { status: 400, body: apiError("calibration-label", { question }) };
  appendProductLabel(deps.home, { question, outputDigest: digest, label, by: deps.labeller(), at: (deps.now?.() ?? new Date()).toISOString() });
  return { status: 200, body: { ok: true, standings: books.standings().labels } };
}
