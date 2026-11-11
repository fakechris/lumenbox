/** Result checks are bounded activities beneath the existing task, never new business tasks. */
import { createHash } from "node:crypto";
import { evidenceDigest, pickReviewers, reviewRound, REVIEW_ACTOR, type VerificationLedger } from "./review-dispatch.ts";
import { auditConversation, type AuditContext } from "./audit-context.ts";
import { buildAuditPrompt } from "./audit.ts";
import type { ResultChecks } from "./result-check-policy.ts";
import type { Task, TaskStore } from "./tasks.ts";

interface Dependencies {
  checks: ResultChecks; verifications: VerificationLedger; tasks: TaskStore;
  candidates: () => string[]; nameOf: (id: string) => string; isAgent: (id: string) => boolean;
  read: (task: Task, path: string) => Promise<{ content: string; truncated: boolean }>;
  ask: (reviewerId: string, prompt: string, audit: AuditContext, conversation: string) => Promise<string>;
  log: (line: string) => void;
}

export async function runResultCheck(task: Task, deps: Dependencies): Promise<void> {
  const policy = deps.checks.snapshot(task).policy;
  const reviewers = policy.mode === "model" ? pickReviewers(task, deps.candidates(), policy.reviewers) : [];
  const { plan, reason } = deps.checks.begin(task, reviewers);
  if (!plan) { deps.tasks.update(task.id, { note: reason ?? "Check held for inspection." }, REVIEW_ACTOR); return; }
  let stopReason = "Check finished; business acceptance remains separate.";
  try {
    if (policy.mode === "files") {
      let verdict: "pass" | "fail" | "none" = "pass";
      const basis: string[] = [];
      for (const file of policy.files) {
        const current = deps.tasks.get(task.id);
        if (!current || !deps.checks.active(current, plan.id)) { stopReason = "Check cancelled, expired or evidence changed."; return; }
        try {
          const read = await deps.read(current, file.path);
          if (read.truncated) { if (verdict !== "fail") verdict = "none"; basis.push(`${file.acceptance}: full file unavailable`); }
          else if (createHash("sha256").update(read.content).digest("hex") !== file.sha256) { verdict = "fail"; basis.push(`${file.acceptance}: file bytes differ from the approved artifact`); }
          else basis.push(`${file.acceptance}: approved file bytes confirmed`);
        } catch { if (verdict !== "fail") verdict = "none"; basis.push(`${file.acceptance}: file could not be read`); }
      }
      const current = deps.tasks.get(task.id);
      if (!current || !deps.checks.active(current, plan.id)) { stopReason = "Check cancelled, expired or evidence changed."; return; }
      deps.verifications.add({ taskId: task.id, digest: plan.digest, reviewerId: "host:files", verdict, basis: basis.join("; ") });
      deps.tasks.update(task.id, { status: verdict === "fail" ? "doing" : "review", note: `File check ${verdict}: ${basis.join("; ")}. ${verdict === "pass" ? "These file conditions passed; the user's acceptance remains separate." : "A person decides the next step."}`.slice(0, 1000) }, REVIEW_ACTOR);
      stopReason = `Deterministic file check: ${verdict}.`;
      return;
    }
    if (policy.mode !== "model") return;
    const outcome = await reviewRound({
      ledger: deps.verifications, k: policy.reviewers, candidates: deps.candidates, nameOf: deps.nameOf, isAgent: deps.isAgent,
      current: id => deps.tasks.get(id), move: (id, change) => { const current = deps.tasks.get(id); if (current && deps.checks.active(current, plan.id)) deps.tasks.update(id, change, REVIEW_ACTOR); }, log: deps.log,
      ask: async (reviewerId, current) => {
        const audit: AuditContext = { taskId: current.id, digest: evidenceDigest(current), reviewerId, planId: plan.id, paths: policy.paths, assigneeId: current.assigneeId, sourceConversation: current.conversation ?? "main" };
        if (!deps.checks.active(current, plan.id, reviewerId)) return { reply: "", voided: "check authority expired or changed" };
        const prompt = buildAuditPrompt({ task: current, assigneeName: deps.nameOf(current.assigneeId ?? ""), conversation: current.conversation }) + `\nUse ReadHistory with agent: ${current.assigneeId ?? ""}, conversation: ${current.conversation ?? "main"}.\nCheck purpose: ${policy.reason}\nCheck acceptance: ${policy.acceptance}\nEvidence paths: ${policy.paths.join(", ") || "task and original conversation only"}\nThis activity has ${policy.reviewers} reviewers and a finite shared budget; disagreement stops here. Do not create probes, execute software or delegate diagnostics.`;
        const reply = await deps.ask(reviewerId, prompt, audit, auditConversation(audit));
        const latest = deps.tasks.get(current.id);
        return latest && deps.checks.active(latest, plan.id, reviewerId) ? { reply } : { reply: "", voided: "check authority expired or changed" };
      },
    }, task);
    stopReason = outcome.settled ? `Result check ${outcome.settled.verdict}; acceptance is separate.` : "Check stopped without agreement; no additional reviewers will be dispatched for this evidence.";
  } finally {
    const recorded = deps.checks.snapshot(task).plans.find(row => row.id === plan.id)?.reason;
    deps.checks.stop(task, plan.id, recorded ?? stopReason);
    const latest = deps.tasks.get(task.id);
    if (recorded && latest?.status === "review" && evidenceDigest(latest) === plan.digest) deps.tasks.update(task.id, { note: `Result check stopped: ${recorded}` }, REVIEW_ACTOR);
  }
}
