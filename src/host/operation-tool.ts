/**
 * RunOperation (INV-1378): an agent runs a published operation — the skill's operation.json — on
 * its own desktop's browser, with no model in the loop. A write operation asks a person once for
 * the whole declared path first. A failure comes back typed, with the step, so the agent can do
 * the task live instead and say the operation needs re-teaching.
 */
import { commitsOf, type Operation, operationProblem, runOperation } from "./operation.ts";
import { desktopRunner } from "./operation-desktop.ts";
import { SKILLS_DIR } from "./skills.ts";
import type { ToolContext } from "./tools.ts";

export function withOperationTool(tools: { name: string; input_schema: unknown }[]): void {
  if (!tools.some(tool => tool.name === "browser_act")) return;
  tools.push({
    name: "RunOperation",
    description:
      "Run a taught operation: a skill whose folder holds operation.json replays its browser (and desktop) steps with no model, " +
      "and returns its output as JSON. Use it when such a skill fits the request — it is faster and more exact than doing the steps yourself. " +
      "If it fails, it says at which step and why; then do the task live and tell the person the operation may need re-teaching.",
    input_schema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "The skill's directory name, as in its path under skills/." },
        input: { type: "object", description: "The operation's inputs, by name." },
      },
      required: ["skill", "input"],
    },
  } as never);
}

export async function runOperationTool(context: ToolContext, input: Record<string, unknown>): Promise<{ text: string; isError?: boolean; approval?: { id: string } }> {
  const box = context.box;
  if (box === undefined || context.displayIndex === undefined) return { text: "Outcome: refused — there is no desktop to run the operation on.", isError: true };
  const slug = String(input.skill ?? "");
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(slug)) return { text: "Outcome: refused — skill is the skill's directory name.", isError: true };
  let op: Operation;
  try {
    op = JSON.parse((await box.readFile(`${SKILLS_DIR}/${slug}/operation.json`)).content) as Operation;
  } catch (error) {
    return { text: `Outcome: failed — ${slug} has no readable operation.json (${error instanceof Error ? error.message : String(error)}).`, isError: true };
  }
  const problem = operationProblem(op);
  if (problem !== undefined) return { text: `Outcome: failed — ${slug}'s operation is invalid: ${problem}.`, isError: true };
  const values = (input.input !== null && typeof input.input === "object" ? input.input : {}) as Record<string, unknown>;
  const commits = commitsOf(op);
  if (commits.length > 0) {
    if (context.policy === undefined) return { text: "Outcome: refused — this operation commits, and there is no one here to approve it.", isError: true };
    const decision = context.policy.check({
      kind: "tool",
      agentId: context.agent.id,
      agentName: context.agent.profile.name,
      tool: "RunOperation",
      input,
      irreversible: `run "${op.name}", which commits ${commits.join(" → ")}`,
      ...(context.turnId !== undefined ? { turnId: context.turnId } : {}),
      principalId: context.caller?.userId,
    });
    if (!decision.allow) return { text: `Outcome: refused — ${decision.reason}`, isError: true, ...(decision.approval !== undefined ? { approval: { id: decision.approval.id } } : {}) };
  }
  const where = { display: context.displayIndex, ...(context.boxOwner !== undefined ? { owner: context.boxOwner } : {}) };
  const result = await runOperation(op, values, request => box.browser({ ...request, ...where }), commits.length > 0, desktopRunner(box, where));
  if (result.ok) return { text: `Outcome: ok. "${op.name}" returned:\n${JSON.stringify(result.output, null, 2)}` };
  return {
    text: `Outcome: failed — "${op.name}" ${result.code}${result.step !== undefined ? ` at step ${result.step}` : ""}: ${result.detail}. The page may have changed since it was taught: do the task live, and tell the person this operation may need re-teaching.`,
    isError: true,
  };
}
