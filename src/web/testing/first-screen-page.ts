/**
 * The rebuilt page's first screen, drawn by the page's own functions outside a browser, for the
 * suite (INV-2311): the sidebar's sandbox headings with their agents, and the getting-started card.
 * Every test of the first screen draws it here, so a test cannot pass on a copy of the page's logic.
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { NEXT_PAGE } from "../page-locale.ts";
import { FIRST_SCREEN_LOGIC_JS } from "../first-screen.ts";

/** The page's own functions, by name, run together in one context with the globals given. */
export function pageFunctions(names: readonly string[], globals: Record<string, unknown>): Record<string, (...args: any[]) => any> {
  const script = [...NEXT_PAGE("en").matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]!).sort((a, b) => b.length - a.length)[0]!;
  const sources = names.map(name => {
    const start = script.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `the page has ${name}`);
    let depth = 0, end = start;
    for (let i = script.indexOf("{", start); i < script.length; i++) {
      if (script[i] === "{") depth++;
      if (script[i] === "}" && --depth === 0) { end = i + 1; break; }
    }
    return script.slice(start, end);
  });
  const context = vm.createContext(globals);
  vm.runInContext(sources.join("\n"), context);
  return Object.fromEntries(names.map(name => [name, context[name] as (...args: any[]) => any]));
}

/** A stand-in for a page element: what was put in it, and what a press on it runs. */
export interface Fake {
  cls: string; text: string; kids: Fake[]; hidden: boolean; disabled: boolean; dataset: Record<string, string>; textContent: string; firstChild?: Fake; href?: string; title?: string; press?: () => void;
  classList: { add(name: string): void };
  appendChild(kid: Fake): void; addEventListener(name: string, run: () => void): void; setAttribute(): void; replaceChildren(): void; replaceWith(): void;
}
export const fakeEl = (_tag: string, cls = "", text?: unknown): Fake => {
  const node: Fake = {
    cls, text: text === undefined || text === null ? "" : String(text), kids: [], hidden: false, disabled: false, dataset: {}, textContent: "", classList: { add(name) { node.cls += ` ${name}`; } },
    appendChild(kid) { node.kids.push(kid); node.firstChild = node.kids[0]; }, addEventListener(_name, run) { node.press = run; }, setAttribute() {},
    replaceChildren() { node.kids = []; node.firstChild = undefined; }, replaceWith() {},
  };
  return node;
};
export const texts = (node: Fake | null | undefined): string[] => (node ? [node.text, ...node.kids.flatMap(texts)].filter(Boolean) : []);

const DRAWING = ["isOrganisation", "canOperateInstallation", "canDriveAgents", "settingsPanes", "boxesKnown", "agentsHere", "agentRow", "renderSide",
  "mySandboxes", "sandboxTitle", "sandboxHeading", "sandboxWhy", "goTo", "firstScreenKey", "firstScreenSeen", "firstScreenSee", "firstAgentOf", "setupCard"];

/** Where a press of the first screen led, as `goTo` (first-screen-ui.ts) was asked. */
export type Destination = Record<string, string | true>;

export interface FirstScreenInput {
  /** `/api/state`, `/api/boxes`, `/api/setup` and `/api/me`, as the server answered this person. */
  state: { agents: { id: string; name: string; boxId?: string }[]; box: Record<string, unknown> };
  computers: { boxes: unknown[]; own: string };
  setup: unknown;
  me: { role: string; identity?: string | null; homeAgentId?: string | null };
  /** The words: the keys themselves unless given. */
  t?: (key: string, vars?: Record<string, string>) => string;
  /** The page's own state of the installation's box: starting, and why the last start failed. */
  starting?: boolean;
  failed?: string;
}

/** The first screen this person sees, and every press it offers. */
export function drawFirstScreen(input: FirstScreenInput) {
  const pressed: Destination[] = [], nodes: Record<string, Fake> = {}, stored = new Map<string, string>();
  const globals: Record<string, unknown> = {
    settings: { setup: input.setup, me: input.me }, boxes: { list: input.computers.boxes, own: input.computers.own, state: input.state.box, starting: !!input.starting, failed: input.failed ?? "", log: [] },
    chat: { box: "", agentId: "" }, next: { agents: Object.fromEntries(input.state.agents.map(agent => [agent.id, agent])), view: "chat", mine: [] },
    teams: {}, member: { paused: {} }, $: (id: string) => (nodes[id] ??= fakeEl("div")), el: fakeEl, t: input.t ?? ((key: string) => key),
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } },
    firstScreenReadyBefore: null, SETTING_PANES: ["model", "boxes", "doors", "team", "mine", "memory", "supervision", "guests"], shellPanes: () => [],
    inTeam: (list: unknown) => list, renderTeams() {}, lineNode: () => fakeEl("span"), memberLine: () => "", initial: String, agentOwes: () => false, boxNotice() {}, render() {}, refreshSoon() {}, failed() {},
    openSettingsPane: (pane: string) => pressed.push({ pane }), openChat: (chat: string) => pressed.push({ chat }), startBox: () => pressed.push({ start: true }),
    postJson: (path: string, body: { id?: string }) => { pressed.push(path === "/api/personal-boxes/retry" ? { retry: String(body.id) } : { post: path }); return Promise.resolve({}); },
    window: { open: (url: string) => pressed.push({ url }) }, openMember: () => pressed.push({ newAgent: true }), createSetupBox: () => pressed.push({ create: true }),
  };
  vm.createContext(globals);
  vm.runInContext(FIRST_SCREEN_LOGIC_JS, globals);
  const page = pageFunctions(DRAWING, globals);
  page.renderSide!();
  const side = nodes.agents!.kids, card = page.setupCard!() as Fake | null;
  const steps = (card?.kids ?? []).filter(row => row.cls === "setup-step");
  return {
    /** Where every press so far led. */
    pressed, page, globals, side, card, panes: page.settingsPanes!() as string[],
    headings: side.filter(node => node.cls === "sandbox-head").map(node => texts(node).join(" ")),
    why: side.filter(node => node.cls === "sandbox-why").map(node => texts(node).join(" | ")),
    agents: side.filter(node => node.cls === "agent").map(node => texts(node.kids[1])[0]!),
    steps: steps.map(row => texts(row).join(" | ")),
    /** Presses every button of the list, in order, and gives where each led. */
    walk(): Destination[] { pressed.length = 0; for (const kid of steps.flatMap(row => row.kids)) kid.press?.(); return [...pressed]; },
    words: [...side.flatMap(texts), ...texts(card)].join(" · "),
  };
}
