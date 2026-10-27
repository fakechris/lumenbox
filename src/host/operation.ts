/**
 * Operations (INV-1378): a demonstration taught once, replayed without a model.
 *
 * A SKILL.md is a recipe a model follows live, which is the right shape for most work and the wrong
 * one for "every Monday, the same report from the same site": each run costs a model, and each run
 * may improvise. An operation is the other shape — a declarative list of browser steps with typed
 * inputs and outputs, interpreted by the host through the box's own browser API. Not code: nothing
 * a model wrote is executed, only steps the host understands (open, act on an element found by
 * role and name, read text with a pattern, wait). It fails loudly and typed — the step, what it
 * expected, what it found — so the agent can fall back to doing it live and say the page changed.
 *
 *   {
 *     "name": "Weekly signups",
 *     "input":  { "week": { "type": "string" } },
 *     "output": { "signups": { "type": "number" } },
 *     "steps": [
 *       { "open": "https://analytics.example.com/reports/{week}" },
 *       { "act": { "action": "click", "find": { "role": "button", "name": "Show table" } } },
 *       { "read": { "as": "signups", "pattern": "Signups\\s+(\\d+)" } }
 *     ]
 *   }
 *
 * A step that submits, pays or deletes carries `commit` (INV-1379's marks); an operation with
 * commits asks a person once per run, for the whole declared path, before its first step. Cases
 * (cases.json) are the operation's own tests; a dry run executes them, and an operation whose
 * cases pass below the threshold cannot be published.
 */
import type { BrowserRequest } from "../protocol/index.ts";

export type FieldType = "string" | "number" | "boolean";
export interface Field {
  type: FieldType;
  description?: string;
}

export type Step =
  | { open: string }
  | { act: { action: "click" | "type" | "key"; find: { role?: string; name?: string; nth?: number }; text?: string; key?: string; commit?: string; expect?: { appears?: string } } }
  | { read: { as: string; pattern: string } }
  | { wait: { for: "text" | "url"; value: string; seconds?: number } };

export interface Operation {
  name: string;
  input: Record<string, Field>;
  output: Record<string, Field>;
  steps: Step[];
}

export interface OperationCase {
  purpose: string;
  input: Record<string, unknown>;
  /** Output fields and a pattern each must match. */
  expect?: Record<string, string>;
}

export type FailureCode = "invalid_input" | "step_failed" | "not_found" | "output_missing" | "output_type" | "needs_approval";
export type RunResult = { ok: true; output: Record<string, unknown> } | { ok: false; code: FailureCode; step?: number; detail: string };

/** The publish threshold: at least this share of an operation's cases pass on a dry run. */
export const CASE_PASS_RATE = 0.7;
const MAX_STEPS = 40;
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;
const TYPES = new Set(["string", "number", "boolean"]);

/** Why this is not a usable operation, or undefined. Checked when a draft is made and again at run time. */
export function operationProblem(value: unknown): string | undefined {
  const op = value as Operation;
  if (op === null || typeof op !== "object") return "an operation is a JSON object";
  if (typeof op.name !== "string" || op.name.trim() === "" || op.name.length > 120) return "name is required";
  for (const [label, fields] of [["input", op.input], ["output", op.output]] as const) {
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return `${label} is an object of fields`;
    for (const [key, field] of Object.entries(fields)) {
      if (!KEY.test(key)) return `${label}.${key}: field names are letters, digits and _`;
      if (!TYPES.has((field as Field)?.type)) return `${label}.${key}: type is string, number or boolean`;
    }
  }
  if (Object.keys(op.output).length === 0) return "output names at least one field";
  if (!Array.isArray(op.steps) || op.steps.length === 0 || op.steps.length > MAX_STEPS) return `steps is a list of 1 to ${MAX_STEPS}`;
  const reads = new Set<string>();
  for (const [index, step] of op.steps.entries()) {
    const at = `steps[${index}]`;
    const kinds = Object.keys(step ?? {});
    if (kinds.length !== 1) return `${at}: one of open, act, read, wait`;
    if ("open" in step) {
      if (typeof step.open !== "string" || !/^https?:\/\/|^file:\/\/\/home\/box\//.test(step.open)) return `${at}: open takes an http(s) URL or a file in the box's work directory`;
    } else if ("act" in step) {
      const act = step.act;
      if (!["click", "type", "key"].includes(act?.action)) return `${at}: act.action is click, type or key`;
      if (act.action !== "key" && (typeof act.find !== "object" || (act.find.role === undefined && act.find.name === undefined))) return `${at}: act finds its element by role and/or name — never by coordinates or a ref`;
      if (act.action === "type" && typeof act.text !== "string") return `${at}: type needs text`;
      if (act.action === "key" && typeof act.key !== "string") return `${at}: key needs key`;
      if (act.commit !== undefined && (typeof act.commit !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,62}$/.test(act.commit))) return `${at}: commit is a short step name`;
    } else if ("read" in step) {
      if (!KEY.test(step.read?.as ?? "") || !(step.read.as in op.output)) return `${at}: read.as names an output field`;
      try {
        new RegExp(step.read.pattern);
      } catch {
        return `${at}: read.pattern is not a valid pattern`;
      }
      reads.add(step.read.as);
    } else if ("wait" in step) {
      if (!["text", "url"].includes(step.wait?.for) || typeof step.wait.value !== "string") return `${at}: wait for text or url, with a value`;
    } else {
      return `${at}: one of open, act, read, wait`;
    }
  }
  const unread = Object.keys(op.output).filter(key => !reads.has(key));
  if (unread.length > 0) return `no step reads output ${unread.join(", ")}`;
  for (const placeholder of JSON.stringify(op.steps).matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (!(placeholder[1]! in op.input)) return `{${placeholder[1]}} is used in a step but is not an input`;
  }
  return undefined;
}

/** The commit marks an operation declares, in step order. */
export function commitsOf(op: Operation): string[] {
  return op.steps.flatMap(step => ("act" in step && step.act.commit !== undefined ? [step.act.commit] : []));
}

function inputProblem(op: Operation, input: Record<string, unknown>): string | undefined {
  for (const [key, field] of Object.entries(op.input)) {
    if (!(key in input)) return `input ${key} is missing`;
    if (typeof input[key] !== field.type) return `input ${key} should be a ${field.type}`;
  }
  const extra = Object.keys(input).filter(key => !(key in op.input));
  return extra.length > 0 ? `unknown input ${extra.join(", ")}` : undefined;
}

/** `{name}` replaced with the input's value; a URL position gets it URL-encoded. */
function fill(template: string, input: Record<string, unknown>, encode = false): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => (encode ? encodeURIComponent(String(input[key])) : String(input[key])));
}

type Browser = (request: BrowserRequest) => Promise<{ outcome?: string; text?: string; url?: string; snapshot?: string }>;

/** The steps in order; the values read, or the first typed failure. */
async function runSteps(steps: readonly Step[], input: Record<string, unknown>, browser: Browser): Promise<RunResult> {
  const output: Record<string, unknown> = {};
  for (const [index, step] of steps.entries()) {
    try {
      if ("open" in step) {
        await browser({ op: "open", url: fill(step.open, input, true) });
      } else if ("act" in step) {
        const act = step.act;
        const result = await browser({
          op: "act",
          action: act.action,
          ...(act.action !== "key" ? { find: act.find } : {}),
          ...(act.text !== undefined ? { text: fill(act.text, input) } : {}),
          ...(act.key !== undefined ? { key: act.key } : {}),
          ...(act.expect?.appears !== undefined ? { expect: { appears: fill(act.expect.appears, input) } } : {}),
          // A commit step reaches the box only after a person approved the run (runOperation).
          ...(act.commit !== undefined ? { confirmed: true } : {}),
        });
        if (result.outcome === "failed" || result.outcome === "refused") return { ok: false, code: "step_failed", step: index, detail: `${act.action} on ${JSON.stringify(act.find ?? act.key)} ${result.outcome}` };
      } else if ("read" in step) {
        const page = await browser({ op: "read" });
        const match = new RegExp(step.read.pattern).exec(page.text ?? "");
        if (match === null) return { ok: false, code: "not_found", step: index, detail: `the page at ${page.url ?? "?"} has nothing matching ${step.read.pattern}` };
        output[step.read.as] = match[1] ?? match[0];
      } else if ("wait" in step) {
        const result = await browser({ op: "wait", waitFor: step.wait.for, value: fill(step.wait.value, input), seconds: step.wait.seconds ?? 15 });
        if (result.outcome === "failed" || result.outcome === "unknown") return { ok: false, code: "step_failed", step: index, detail: `waited for ${step.wait.for} "${step.wait.value}" and it did not come` };
      }
    } catch (error) {
      return { ok: false, code: "step_failed", step: index, detail: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: true, output };
}

/**
 * Runs an operation. `browser` is the box's browser for the agent's desktop; `approved` says a
 * person approved this run's commit steps (asked once by the caller, before the first step).
 */
export async function runOperation(op: Operation, input: Record<string, unknown>, browser: Browser, approved = false): Promise<RunResult> {
  const problem = operationProblem(op);
  if (problem !== undefined) return { ok: false, code: "step_failed", detail: `the operation is invalid: ${problem}` };
  const badInput = inputProblem(op, input);
  if (badInput !== undefined) return { ok: false, code: "invalid_input", detail: badInput };
  if (commitsOf(op).length > 0 && !approved) return { ok: false, code: "needs_approval", detail: `this operation commits (${commitsOf(op).join(" → ")}); a person approves the run first` };
  const ran = await runSteps(op.steps, input, browser);
  if (!ran.ok) return ran;
  const output = ran.output;
  for (const [key, field] of Object.entries(op.output)) {
    if (!(key in output)) return { ok: false, code: "output_missing", detail: `no value for ${key}` };
    if (field.type === "number") {
      const n = Number(String(output[key]).replace(/[,\s]/g, ""));
      if (!Number.isFinite(n)) return { ok: false, code: "output_type", detail: `${key} is "${output[key]}", not a number` };
      output[key] = n;
    } else if (field.type === "boolean") {
      output[key] = /^(true|yes|1|on)$/i.test(String(output[key]));
    }
  }
  return { ok: true, output };
}

/**
 * Each case run and judged: the run succeeded and every expected field matches its pattern. A dry
 * run never commits — an operation that writes is run up to its first commit step, and a case
 * passes when every step before it went through.
 */
export async function runCases(op: Operation, cases: readonly OperationCase[], browser: Browser): Promise<{ passed: number; total: number; failures: string[] }> {
  const failures: string[] = [];
  let passed = 0;
  const firstCommit = op.steps.findIndex(step => "act" in step && step.act.commit !== undefined);
  for (const one of cases) {
    const badInput = inputProblem(op, one.input);
    const result: RunResult = badInput !== undefined ? { ok: false, code: "invalid_input", detail: badInput }
      : firstCommit >= 0 ? await runSteps(op.steps.slice(0, firstCommit), one.input, browser)
      : await runOperation(op, one.input, browser);
    if (!result.ok) {
      failures.push(`${one.purpose}: ${result.code}${result.step !== undefined ? ` at step ${result.step}` : ""} — ${result.detail}`);
      continue;
    }
    const wrong = firstCommit >= 0 ? undefined : Object.entries(one.expect ?? {}).find(([key, pattern]) => !new RegExp(pattern).test(String(result.output[key])));
    if (wrong !== undefined) failures.push(`${one.purpose}: ${wrong[0]} was "${result.output[wrong[0]]}", wanted /${wrong[1]}/`);
    else passed += 1;
  }
  return { passed, total: cases.length, failures };
}

/** Whether a dry run clears the publish gate. */
export function casesPass(result: { passed: number; total: number }, rate = CASE_PASS_RATE): boolean {
  return result.total >= 1 && result.passed / result.total >= rate;
}
