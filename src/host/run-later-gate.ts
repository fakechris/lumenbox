/**
 * The run-later tier at dispatch, and its words (INV-1861).
 *
 * The table and the recognition are run-later-paths.ts, which is pure; the card's words are
 * run-later-words.ts. This file is the part that needs a tool's context: the one request dispatch
 * puts to the policy gate for a tool call, and the second question a file tool asks once it has
 * read what a package.json held.
 */

import type { BoxClient } from "../box/client.ts";
import { MAIN_CONVERSATION } from "../agents/registry.ts";
import { levelOfCurrentTask } from "./autonomy-level.ts";
import { splitWhy } from "./consent-case.ts";
import type { PolicyRequest } from "./policy.ts";
import { packageRunChanges, runLaterPath } from "./run-later-paths.ts";
import type { ToolOutcome } from "./tool-outcome.ts";
import type { ToolContext } from "./tools.ts";

/**
 * What dispatch asks the gate about a tool call: who is calling, for whom, on which task and
 * machine. One function, so the second question below is asked as the same caller as the first.
 */
export function toolGateRequest(name: string, input: Record<string, unknown>, context: ToolContext): Extract<PolicyRequest, { kind: "tool" }> {
  const { input: asked, why } = splitWhy(input); // the agent's case rides beside the action, never inside it (INV-1651)
  const level = levelOfCurrentTask(context); // the level of the task this turn is doing (INV-1650)
  return {
    kind: "tool",
    ...(context.work ? { returnTo: { work: context.work, conversation: context.conversation ?? MAIN_CONVERSATION } } : {}),
    agentId: context.agent.id,
    agentName: context.agent.profile.name,
    tool: name,
    input: asked,
    ...(why !== undefined ? { why } : {}),
    // Whose turn this is, so a rule a person wrote about their own routine work applies from whichever door they drove it (INV-156).
    ...(context.caller?.userId !== undefined ? { principalId: context.caller.userId } : {}),
    ...(context.callerName !== undefined ? { principalName: context.callerName } : {}),
    ...(level !== undefined ? { taskLevel: level } : {}),
    ...(context.boxKind === "host" ? { onHostBox: true as const } : {}), // a write on the person's own machine asks (INV-1700)
    ...(context.turnId !== undefined ? { turnId: context.turnId } : {}),
    ...(context.toolUseId !== undefined ? { callId: context.toolUseId } : {}), // the step the verdict is drawn on (INV-1664)
  };
}

/**
 * A file tool about to write a file judged by its contents (a package.json): asks the gate only
 * when what the file would run changes, and returns the refusal when the answer is not yes.
 *
 * Every other run-later file was judged by its path before dispatch reached the tool. This one
 * cannot be: most writes to a package.json change a version or a dependency, and asking about
 * those would teach a person to click through the card that matters. `before` is what the file
 * holds now when the tool has already read it; otherwise it is read here, and a file that is not
 * there or cannot be read is one that ran nothing.
 */
export async function runLaterContentCheck(
  context: ToolContext,
  box: Pick<BoxClient, "readFile">,
  name: string,
  input: Record<string, unknown>,
  path: string,
  after: string,
  before?: string
): Promise<ToolOutcome | undefined> {
  const entry = runLaterPath(path);
  if (entry?.byContent !== true || context.policy === undefined) return undefined;
  const was = before ?? (await box.readFile(path).then(file => (file.truncated ? undefined : file.content), () => undefined));
  if (packageRunChanges(was, after).length === 0) return undefined;
  const decision = context.policy.check({ ...toolGateRequest(name, input, context), runLater: { path, by: entry.by } });
  if (decision.allow) return undefined;
  return { text: decision.reason, isError: true, ...(decision.approval !== undefined ? { approval: { id: decision.approval.id } } : {}) };
}
