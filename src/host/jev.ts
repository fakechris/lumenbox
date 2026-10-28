/**
 * A typed decision model beside the cheap profile (INV-1412).
 *
 * Several places in the host ask a small generative model a closed question — is this memory an
 * instruction somebody read, does this reply answer the request, which of these memories matter —
 * and parse a JSON answer out of prose. A decision model answers those directly: a yes/no
 * probability, a distribution over named options, a position on a scale, or a box in an image,
 * every question in one request, in well under a second, and never as free text.
 *
 * Each judgement point has its own switch (`AGENTBOX_JEV_<POINT>`, read through config.ts):
 *
 *   - `off`    — the default. The point does what it did before; no remote call is made.
 *   - `shadow` — the point still uses its own path, and the decision model is asked the same
 *                question in the background; both answers go to `jev-shadow.jsonl` as summaries
 *                (verdicts and hashes, never the text judged), so agreement can be measured first.
 *   - `on`     — the decision model answers; if it fails, the point's own path answers instead.
 *
 * What this never does: let the decision model be the only thing that permits an action. It reads
 * literally and has no defence against instructions written into what it is shown, so wherever a
 * judgement guards something, its answer may only make the outcome more careful.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { agentboxHome, jevSwitch, typesafeToken } from "../config.ts";
import { appendLine } from "./jsonl.ts";

/** The places that can use it. One switch each; the name is the variable's suffix. */
export type JevPoint =
  | "memory_judge"
  | "answer_review"
  | "memory_select"
  | "auto_review"
  | "routine_resolve"
  | "computer_verify"
  | "computer_wait"
  | "computer_click"
  | "computer_guard";

export type JevMode = "off" | "shadow" | "on";

export type Question =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "box"; instructions: string };

/** A still image the state refers to by `ref`, a string that must not occur in the text by accident. */
export interface JevImage {
  ref: string;
  format: "png" | "jpg";
  base64: string;
}

export interface JevRequest {
  state: unknown;
  questions: Record<string, Question>;
  images?: readonly JevImage[];
}

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> }
  | { type: "box"; box: { top: number; bottom: number; left: number; right: number }; confidence: number };

export interface JevResult {
  model: string;
  answers: Record<string, Answer>;
  inputTokens?: number;
  ms: number;
}

export type JevAsk = (request: JevRequest) => Promise<JevResult>;

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_TIMEOUT_MS = 15_000;

/** A failure that is safe to log: the status and the vendor's error kind, never the request or the key. */
export class JevError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const unit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** One answer, checked against the question it answers. Anything off-shape is an error, not a guess. */
function checkAnswer(id: string, question: Question, raw: unknown): Answer {
  const answer = (raw ?? {}) as Record<string, unknown>;
  const fail = (why: string) => new JevError(`answer ${id}: ${why}`);
  if (answer.type !== question.type) throw fail(`expected ${question.type}, got ${String(answer.type)}`);
  switch (question.type) {
    case "noul":
      if (!unit(answer.noul)) throw fail("noul is not a probability");
      return { type: "noul", noul: answer.noul };
    case "choice": {
      const choice = answer.choice;
      if (typeof choice !== "string" || !(choice in question.criteria)) throw fail("choice is not one of the options");
      if (!unit(answer.confidence)) throw fail("confidence is not a probability");
      return { type: "choice", choice, confidence: answer.confidence, probabilities: probabilitiesOf(answer.probabilities) };
    }
    case "score":
      if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1) throw fail("score is off the scale");
      if (!unit(answer.confidence)) throw fail("confidence is not a probability");
      return { type: "score", score: answer.score, confidence: answer.confidence, probabilities: probabilitiesOf(answer.probabilities) };
    case "box": {
      const box = (answer.box ?? {}) as Record<string, unknown>;
      const { top, bottom, left, right } = box;
      if (!unit(top) || !unit(bottom) || !unit(left) || !unit(right) || left > right || top > bottom) throw fail("box edges are not a box");
      if (!unit(answer.confidence)) throw fail("confidence is not a probability");
      return { type: "box", box: { top, bottom, left, right }, confidence: answer.confidence };
    }
  }
}

function probabilitiesOf(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value === null || typeof value !== "object") return out;
  for (const [key, p] of Object.entries(value as Record<string, unknown>)) if (unit(p)) out[key] = p;
  return out;
}

/**
 * The vendor client. Node's own fetch, which does not read HTTP_PROXY: a proxied request measured
 * four times slower (1.1 s against 0.26 s), and nothing here needs to leave through the proxy.
 */
export function typesafeClient(options: {
  token: string;
  fetch?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  model?: string;
}): JevAsk {
  const doFetch = options.fetch ?? fetch;
  return async request => {
    const started = Date.now();
    const images = request.images ?? [];
    const body = {
      model: options.model ?? "jev-latest",
      state: request.state,
      questions: request.questions,
      ...(images.length > 0
        ? { assets: Object.fromEntries(images.map(image => [image.ref, { type: "image", format: image.format, data_base64: image.base64 }])) }
        : {}),
    };
    const usesImages = images.length > 0 || Object.values(request.questions).some(question => question.type === "box");
    let response: Response;
    try {
      response = await doFetch(options.endpoint ?? JEV_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
          ...(usesImages ? { "TypeSafe-Danger-Zone-Images": "true" } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? JEV_TIMEOUT_MS),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      throw new JevError(name === "TimeoutError" ? "the decision model did not answer in time" : "the decision model could not be reached");
    }
    if (!response.ok) {
      // The vendor's error kind only: its message can quote the request back.
      let kind = "";
      try {
        const parsed = (await response.json()) as { error?: { type?: unknown; code?: unknown } };
        const value = parsed.error?.type ?? parsed.error?.code;
        if (typeof value === "string") kind = ` (${value.slice(0, 60)})`;
      } catch {
        // No body worth reading.
      }
      throw new JevError(`the decision model answered ${response.status}${kind}`, response.status);
    }
    const parsed = (await response.json()) as { model?: unknown; answers?: Record<string, unknown>; usage?: { input_tokens?: unknown } };
    const answers: Record<string, Answer> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      if (parsed.answers === undefined || !(id in parsed.answers)) throw new JevError(`answer ${id}: missing`);
      answers[id] = checkAnswer(id, question, parsed.answers[id]);
    }
    return {
      model: typeof parsed.model === "string" ? parsed.model : "unknown",
      answers,
      ...(typeof parsed.usage?.input_tokens === "number" ? { inputTokens: parsed.usage.input_tokens } : {}),
      ms: Date.now() - started,
    };
  };
}

/** The client for this installation, or undefined when no credential is set. */
export function jevClient(): JevAsk | undefined {
  const token = typesafeToken();
  return token === undefined ? undefined : typesafeClient({ token });
}

/** The answer under `id`, narrowed to its type. The client already checked every answer exists. */
export function noulOf(result: JevResult, id: string): number {
  const answer = result.answers[id];
  if (answer?.type !== "noul") throw new JevError(`answer ${id}: not a noul`);
  return answer.noul;
}

export function choiceOf(result: JevResult, id: string): Extract<Answer, { type: "choice" }> {
  const answer = result.answers[id];
  if (answer?.type !== "choice") throw new JevError(`answer ${id}: not a choice`);
  return answer;
}

export function boxOf(result: JevResult, id: string): Extract<Answer, { type: "box" }> {
  const answer = result.answers[id];
  if (answer?.type !== "box") throw new JevError(`answer ${id}: not a box`);
  return answer;
}

/** Short and one-way: enough to tell two judged texts apart in the shadow log, not to read them. */
export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export interface ShadowEntry {
  at: string;
  point: JevPoint;
  /** What the point's own path decided, as a summary the caller chose. Never the judged text. */
  own: unknown;
  /** What the decision model decided, the same way; absent when it failed. */
  jev?: unknown;
  error?: string;
  ms?: number;
}

export interface SwitchDeps {
  mode: (point: JevPoint) => JevMode;
  client: () => JevAsk | undefined;
  record: (entry: ShadowEntry) => void;
  log: (line: string) => void;
}

export const defaultSwitchDeps: SwitchDeps = {
  mode: point => jevSwitch(point),
  client: jevClient,
  record: entry => appendLine(join(agentboxHome(), "jev-shadow.jsonl"), JSON.stringify(entry)),
  log: line => console.error(`[jev] ${line}`),
};

/** The same dependencies with `on` read as `shadow`: for points where the decision model may only be compared, never decide. */
export function shadowOnly(deps: SwitchDeps = defaultSwitchDeps): SwitchDeps {
  return { ...deps, mode: point => (deps.mode(point) === "on" ? "shadow" : deps.mode(point)) };
}

/** The switch's effective mode: `off` whenever there is no credential to act on it with. */
export function modeFor(point: JevPoint, deps: SwitchDeps = defaultSwitchDeps): { mode: JevMode; ask?: JevAsk } {
  const mode = deps.mode(point);
  if (mode === "off") return { mode };
  const ask = deps.client();
  return ask === undefined ? { mode: "off" } : { mode, ask };
}

/**
 * Runs one judgement the way its switch says.
 *
 * `own` is the point's existing path and is always available; `jev` asks the decision model. The
 * summaries go to the shadow log and must not contain the text that was judged.
 */
export async function switched<T>(
  point: JevPoint,
  paths: { own: () => Promise<T>; jev: (ask: JevAsk) => Promise<T>; summary: (value: T) => unknown },
  deps: SwitchDeps = defaultSwitchDeps
): Promise<T> {
  const { mode, ask } = modeFor(point, deps);
  if (mode === "off" || ask === undefined) return paths.own();
  if (mode === "on") {
    try {
      return await paths.jev(ask);
    } catch (error) {
      deps.log(`${point}: the decision model failed (${error instanceof Error ? error.message : String(error)}); using the default path`);
      return paths.own();
    }
  }
  const own = await paths.own();
  const started = Date.now();
  void paths
    .jev(ask)
    .then(value => deps.record({ at: new Date().toISOString(), point, own: paths.summary(own), jev: paths.summary(value), ms: Date.now() - started }))
    .catch(error => deps.record({ at: new Date().toISOString(), point, own: paths.summary(own), error: error instanceof Error ? error.message : String(error), ms: Date.now() - started }))
    .catch(() => {
      // A shadow log that cannot be written is not worth failing a judgement over.
    });
  return own;
}
