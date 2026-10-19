/**
 * ShowUI: the agent composes a card out of A2UI v0.9 components, and the host checks it
 * against the one small catalog lumenbox renders (docs/79).
 *
 * Three decisions live here. The catalog is a named subset of A2UI's basic catalog, so the
 * page, Feishu and the text fallback all know every component by sight; nothing that
 * carries an external URL or has no card equivalent is in it. Validation runs the real
 * `MessageProcessor` from `@a2ui/web_core`, the same code the page renders with, so the
 * host never accepts what the page would refuse. And what is kept per surface is the full
 * message list that rebuilds it — the tool input is shorthand for the model; the messages
 * are what travels and what is stored.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BASIC_COMPONENTS, Catalog, MessageProcessor, STRICT_VALIDATION } from "@a2ui/web_core/v0_9";
import { LUMENBOX_COMPONENTS } from "./show-ui-components.ts";
import { agentboxHome, envNumber } from "../config.ts";
import { appendLine, type LedgerKind } from "./jsonl.ts";

import { type A2uiMessage, actionText, SHOW_UI_CATALOG_ID, SHOW_UI_COMPONENTS, SHOW_UI_PROTOCOL, SHOW_UI_ROOT } from "./show-ui-catalog.ts";

export { type A2uiMessage, actionText, SHOW_UI_CATALOG_ID, SHOW_UI_COMPONENTS, SHOW_UI_PROTOCOL, SHOW_UI_ROOT };

/** More than this is not a card; it is a page, and the page would crawl. */
export const SHOW_UI_MAX_COMPONENTS = 80;

const names = new Set(SHOW_UI_COMPONENTS);
type ShowUiCatalog = Catalog<(typeof BASIC_COMPONENTS)[number] | (typeof LUMENBOX_COMPONENTS)[number]>;
let catalog: ShowUiCatalog | undefined;

/** The lumenbox catalog, built once from the basic catalog's component definitions. */
export function showUiCatalog(): ShowUiCatalog {
  if (catalog === undefined) {
    catalog = new Catalog(SHOW_UI_CATALOG_ID, SHOW_UI_PROTOCOL, [...BASIC_COMPONENTS.filter(api => names.has(api.name)), ...LUMENBOX_COMPONENTS]);
  }
  return catalog;
}

/** What the tool takes, after the handler's shape checks. */
export interface ShowUiInput {
  surface: string;
  components?: unknown;
  data?: unknown;
  title?: string;
  close?: boolean;
}

/** A surface as last drawn: enough to redraw it whole in any later process. */
export interface SurfaceRecord {
  agentId: string;
  agentName: string;
  conversation: string;
  surfaceId: string;
  title?: string;
  /** The messages that build the surface from nothing. */
  messages: A2uiMessage[];
  at: string;
}

export type Compiled =
  | { ok: true; /** What to send now. */ send: A2uiMessage[]; /** What rebuilds the surface from nothing; empty after a close. */ full: A2uiMessage[] }
  | { ok: false; reason: string };

/**
 * Turns one ShowUI call into A2UI messages and proves them against the catalog.
 *
 * A first call creates the surface; a later call for the same surface only sends the new
 * components, since every call carries the whole card. Validation replays the full list
 * through a throwaway processor, so an update that would leave the page with a broken
 * surface is refused before anything is sent.
 */
export function compileSurface(input: ShowUiInput, existing: SurfaceRecord | undefined): Compiled {
  const surfaceId = input.surface;
  if (input.close === true) {
    if (existing === undefined) return { ok: false, reason: `There is no card "${surfaceId}" to close.` };
    return { ok: true, send: [{ version: "v0.9", deleteSurface: { surfaceId } }], full: [] };
  }
  if (!Array.isArray(input.components) || input.components.length === 0) {
    return { ok: false, reason: "Pass `components`: a non-empty array of A2UI components, one of them with id \"root\"." };
  }
  if (input.components.length > SHOW_UI_MAX_COMPONENTS) {
    return { ok: false, reason: `A card holds at most ${SHOW_UI_MAX_COMPONENTS} components; this one has ${input.components.length}. Split it, or show less.` };
  }
  const components: Record<string, unknown>[] = [];
  for (const raw of input.components) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "Every component is an object with `id` and `component`." };
    const component = normalizeComponent(raw as Record<string, unknown>);
    if (typeof component.id !== "string" || component.id === "") return { ok: false, reason: "Every component needs a string `id`." };
    if (typeof component.component !== "string" || !names.has(component.component)) {
      return {
        ok: false,
        reason: `Component "${String(component.component)}" (${component.id}) is not in the catalog. Available: ${SHOW_UI_COMPONENTS.join(", ")}.`,
      };
    }
    const local = localFunction(component);
    if (local !== undefined) return { ok: false, reason: `Component ${component.id}: actions are events only (\`{"event": {"name": ...}}\`); "${local}" is not allowed.` };
    components.push(component);
  }
  if (!components.some(component => component.id === SHOW_UI_ROOT)) {
    return { ok: false, reason: `One component must have id "${SHOW_UI_ROOT}"; it is the one the card shows.` };
  }
  if (input.data !== undefined && (input.data === null || typeof input.data !== "object" || Array.isArray(input.data))) {
    return { ok: false, reason: "`data` is an object; components bind to it with {\"path\": \"/key\"}." };
  }
  const update: A2uiMessage = { version: "v0.9", updateComponents: { surfaceId, components } };
  const full: A2uiMessage[] = [{ version: "v0.9", createSurface: { surfaceId, catalogId: SHOW_UI_CATALOG_ID } }, update];
  if (input.data !== undefined) full.push({ version: "v0.9", updateDataModel: { surfaceId, path: "/", value: input.data } });
  const reason = proveSurface(full);
  if (reason !== undefined) return { ok: false, reason };
  return { ok: true, send: existing === undefined ? full : full.slice(1), full };
}

/**
 * What a model actually sends, read as what it meant. Two shapes seen on the first live run
 * (2026-10-19, MiniMax through its Anthropic-compatible endpoint): every array nested inside
 * the untyped component object arrived as `{"item": [...]}` — the provider's encoding, not
 * the model's choice, and the model could not fix it however it rewrote the call — and the
 * first attempt named the kind `type` rather than `component`. A schema does not bind a
 * model; the reader takes what was meant. No catalog property is called `item`, so the
 * unwrap cannot eat a real value.
 */
export function normalizeComponent(component: Record<string, unknown>): Record<string, unknown> {
  const unwrapped = unwrapItems(component) as Record<string, unknown>;
  // An Approve is always the same pair of presses (INV-1280); the agent names them only when
  // it wants a context on them.
  if ((unwrapped.component ?? unwrapped.type) === "Approve") {
    if (unwrapped.onApprove === undefined) unwrapped.onApprove = { event: { name: "approve" } };
    if (unwrapped.onReject === undefined) unwrapped.onReject = { event: { name: "reject" } };
  }
  if (typeof unwrapped.component !== "string" && typeof unwrapped.type === "string") {
    const { type, ...rest } = unwrapped;
    return { ...rest, component: type };
  }
  return unwrapped;
}

function unwrapItems(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(unwrapItems);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === "item") {
    const inner = unwrapItems(record.item);
    return Array.isArray(inner) ? inner : [inner];
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = unwrapItems(record[key]);
  return out;
}

/** The name of a client-side function call anywhere in a component's actions, if one is there. */
function localFunction(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) { const found = localFunction(item); if (found !== undefined) return found; }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const call = record.functionCall;
  if (call !== null && typeof call === "object") return String((call as Record<string, unknown>).call ?? "functionCall");
  for (const key of Object.keys(record)) {
    if (key === "component" || key === "id") continue;
    const found = localFunction(record[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Runs the messages through the page's own processor; the first complaint is the reason. */
export function proveSurface(messages: readonly A2uiMessage[]): string | undefined {
  const processor = new MessageProcessor([showUiCatalog()], undefined, { validationConfig: STRICT_VALIDATION });
  try {
    processor.processMessages(messages as never);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    processor.dispose();
  }
}

export const ACTION_LINE = /^\[Action "([^"]+)" on card ([^\s:\]]+)(?:: (.*))?\]$/s;

/** The reverse of `actionText`, for whoever receives the line and wants the parts. */
export function parseActionText(text: string): { name: string; surfaceId: string; context?: Record<string, unknown> } | undefined {
  const match = ACTION_LINE.exec(text.trim());
  if (match === null) return undefined;
  const [, name, surfaceId, raw] = match;
  if (raw === undefined) return { name: name!, surfaceId: surfaceId! };
  try {
    const context = JSON.parse(raw) as unknown;
    return context !== null && typeof context === "object" && !Array.isArray(context)
      ? { name: name!, surfaceId: surfaceId!, context: context as Record<string, unknown> }
      : { name: name!, surfaceId: surfaceId! };
  } catch {
    return { name: name!, surfaceId: surfaceId! };
  }
}

// ── the ledger ────────────────────────────────────────────────────────────────────

export const LEDGER_KIND: LedgerKind = "state";

export function surfaceLedgerPath(): string {
  return process.env.AGENTBOX_SURFACES_LOG ?? join(agentboxHome(), "surfaces.jsonl");
}

type SurfaceLine = { kind: "surface"; record: SurfaceRecord } | { kind: "closed"; key: string };

function keyOf(agentId: string, conversation: string, surfaceId: string): string {
  return `${agentId}\u0000${conversation}\u0000${surfaceId}`;
}

/**
 * Which surfaces are showing, now. Same jsonl shape as the card ledger: append per
 * change, latest line per surface wins, a torn tail costs one line, closed stays closed.
 */
export class SurfaceLedger {
  private readonly byKey = new Map<string, SurfaceRecord>();
  private lines = 0;
  private readonly compactAt = envNumber("AGENTBOX_SURFACES_COMPACT_AT", 2_000);

  constructor(
    private readonly path: string | null = surfaceLedgerPath(),
    private readonly onWarn: (message: string) => void = () => {}
  ) {
    this.replay();
  }

  record(record: SurfaceRecord): void {
    this.byKey.set(keyOf(record.agentId, record.conversation, record.surfaceId), record);
    this.append({ kind: "surface", record });
  }

  get(agentId: string, conversation: string, surfaceId: string): SurfaceRecord | undefined {
    const record = this.byKey.get(keyOf(agentId, conversation, surfaceId));
    return record === undefined ? undefined : { ...record, messages: [...record.messages] };
  }

  /** Every surface showing, newest last; narrowed to one agent when asked. */
  list(agentId?: string): SurfaceRecord[] {
    return [...this.byKey.values()].filter(record => agentId === undefined || record.agentId === agentId).map(record => ({ ...record, messages: [...record.messages] }));
  }

  close(agentId: string, conversation: string, surfaceId: string): void {
    const key = keyOf(agentId, conversation, surfaceId);
    if (!this.byKey.delete(key)) return;
    this.append({ kind: "closed", key });
  }

  private append(line: SurfaceLine): void {
    if (this.path === null) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendLine(this.path, JSON.stringify(line));
      this.lines += 1;
      if (this.lines > this.compactAt) this.compact();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`surfaces: cannot write ${this.path} (${detail})`);
    }
  }

  private replay(): void {
    if (this.path === null || !existsSync(this.path)) return;
    try {
      let lines = 0;
      for (const raw of readFileSync(this.path, "utf8").split("\n")) {
        if (raw.trim() === "") continue;
        lines += 1;
        try {
          const line = JSON.parse(raw) as SurfaceLine;
          if (line.kind === "closed" && typeof line.key === "string") {
            this.byKey.delete(line.key);
          } else if (line.kind === "surface" && typeof line.record?.surfaceId === "string") {
            this.byKey.set(keyOf(line.record.agentId, line.record.conversation, line.record.surfaceId), line.record);
          }
        } catch {
          // A torn last line costs one update, not the ledger.
        }
      }
      this.lines = lines;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`surfaces: cannot read ${this.path} (${detail})`);
    }
  }

  private compact(): void {
    if (this.path === null) return;
    try {
      const kept = [...this.byKey.values()].map(record => JSON.stringify({ kind: "surface", record } satisfies SurfaceLine));
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8");
      renameSync(temp, this.path);
      this.lines = kept.length;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`surfaces: cannot compact ${this.path} (${detail})`);
    }
  }
}
