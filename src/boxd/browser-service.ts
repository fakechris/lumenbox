/**
 * Driving the box's browser semantically, rather than by pixel.
 *
 * The desktop tool can already click anything, and will remain the way to deal with a
 * page that defeats this one. What it cannot do is read a page cheaply: finding a button
 * by eye costs a screenshot and a round of vision every time, and the model has to hold
 * coordinates in its head that stop being true the moment anything reflows. Here a page
 * arrives as an outline with a handle on every actionable thing, and an action names the
 * handle. A form that took a dozen screenshots takes two calls.
 *
 * Two rules shape everything below.
 *
 * Every action ends by taking a fresh snapshot. This is not politeness — it is what makes
 * page-lifetime refs safe. An agent's refs are always the ones from the snapshot it was
 * just handed, so "the ref went stale because the page changed underneath me" stops being
 * a failure mode instead of being recovered from.
 *
 * A dialog is handled the moment it opens. Not a nicety either: with Page enabled, a
 * `confirm()` blocks the renderer until someone answers it, so an unarmed handler means
 * the first site that asks a question freezes the browser until the command times out.
 * Verified against the box's own Chromium rather than assumed.
 */

import type { Outcome, WaitOutcome, ActExpectation, Effect } from "../protocol/index.ts";
import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { CdpError, CdpSession, closeTarget, listTargets, openTarget, type CdpTarget } from "./cdp.ts";
import { MAX_NODES, MAX_READ_CHARS, READ_SCRIPT, snapshotScript, findScript, MUTATIONS_SCRIPT, STALE_MUTATIONS } from "./browser-snapshot.ts";

/**
 * The desktop the upgrade check runs on.
 *
 * Not an agent's. The check drives a real browser on a real X display, and doing that on
 * display 1 meant every upgrade navigated whatever Ada had open away to the check page —
 * in front of whoever was watching. The top of the range boxd allows rather than an arbitrary high number, which it rejects outright. Agents are given desktops from 1 upward, so the last one is furthest from anything in use, and it is
 * brought up on demand like any other desktop, so this still exercises the path agents
 * actually use rather than a headless imitation of it.
 */
export const SCRATCH_DISPLAY = 32;

interface FrameNode {
  frame: { id: string; url: string };
  childFrames?: FrameNode[];
}

/** Debugging ports are per desktop, matching the profile-per-desktop split in box-chrome. */
export const CDP_PORT_BASE = 9222;
export const portForDisplay = (display: number): number => CDP_PORT_BASE + display;

/** How long to let a page finish moving once it has stopped loading. */
const SETTLE_MS = 800;
/** How long a navigation may take before the snapshot is taken of whatever is there. */
const LOAD_TIMEOUT_MS = 15_000;
/**
 * How long to watch for a navigation to begin after a click or a keypress.
 *
 * Most clicks navigate nowhere, so this is the common path and it has to be short. It
 * also cannot be zero: a click that does navigate takes a moment to say so, and starting
 * the snapshot before then reads the old page.
 */
const NAVIGATION_GRACE_MS = 500;
/** How long to keep waiting for a script-rendered page to stop growing. */
const CONTENT_SETTLE_MAX_MS = 6_000;
const CONTENT_POLL_MS = 400;
/** How many identical empty samples mean "this page has no text at all", not "not yet". */
const EMPTY_SETTLE_SAMPLES = 3;

/** How long to wait for a browser we started to become drivable. */
const BROWSER_START_TIMEOUT_MS = 30_000;
/** How long a wait-for condition may be waited on, unless the caller asks for less. */
const WAIT_DEFAULT_MS = 10_000;
const WAIT_MAX_MS = 60_000;

/**
 * Where a file may be uploaded from.
 *
 * An upload path arrives from the model, and the model reads pages written by other
 * people — "attach the file at /home/box/.config/box-chrome-1/Default/Cookies" is a
 * plausible sentence on a hostile page, and the browser would happily post it. The box
 * filesystem being the agent's own does not make every file in it fair game to send out.
 */
const UPLOAD_ROOTS = ["/home/box/work", "/tmp", "/home/box/Downloads"];
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Checks a file may be sent to a website, and says why not when it may not.
 *
 * Separated out so it can be tested without a browser: this is the boundary between the
 * box's filesystem and the open web, and it is worth being sure about.
 */
export function checkUpload(
  path: string,
  /** Overridden only by tests, which run on a host whose temp directory is elsewhere. */
  roots: readonly string[] = UPLOAD_ROOTS
): string | undefined {
  if (!path.startsWith("/")) return `${path} is not an absolute path.`;
  let real: string;
  try {
    // Resolved first, because a symlink is the obvious way to point at a file outside
    // the roots while naming one inside them.
    real = realpathSync(path);
  } catch {
    return `${path} is not a file in your box.`;
  }
  if (real.split("/").some(part => part.startsWith("."))) {
    return `${path} is in a hidden directory. Those hold configuration and credentials, ` +
      `not things to upload — copy what you mean to send into your work directory first.`;
  }
  if (!roots.some(root => real === root || real.startsWith(`${root}/`))) {
    return `${path} is outside ${roots.join(", ")}, which are the only places a ` +
      `file may be uploaded from. Copy it into your work directory first.`;
  }
  let size: number;
  try {
    const stat = statSync(real);
    if (!stat.isFile()) return `${path} is not a file.`;
    size = stat.size;
  } catch {
    return `${path} could not be read.`;
  }
  if (size > UPLOAD_MAX_BYTES) {
    return `${path} is ${Math.round(size / 1024 / 1024)}MB; the limit is ` +
      `${UPLOAD_MAX_BYTES / 1024 / 1024}MB.`;
  }
  return undefined;
}

/**
 * How to answer a dialog the page raised, and what to tell the agent about it.
 *
 * Which way to answer is a judgement and the safe direction differs by kind. Leaving a
 * page is what the agent asked for when it navigated, so `beforeunload` is accepted, and
 * an alert has only one button. A `confirm` is the page asking permission for something
 * the agent has not seen the wording of — so it is declined, and the question is reported
 * so the agent can act again deliberately if it did mean to agree.
 *
 * Separated from the connection so the decision can be tested without a browser, since it
 * is the part where being wrong is expensive: accepting by default would mean any page
 * that asks "delete everything?" gets a yes from a program that never read the question.
 */
export function dialogAnswer(kind: string, message: string): { accept: boolean; note: string } {
  const accept = kind === "beforeunload" || kind === "alert";
  return {
    accept,
    note:
      `The page asked (${kind}): ${JSON.stringify(message)} — ` +
      (accept ? "accepted." : "declined, because you had not seen it. Act again if you meant to agree."),
  };
}

/**
 * The ref an agent holds is older than the page.
 *
 * Distinct from a CdpError so the box answers 409 and the host reads it as refused: the
 * same call gets the same answer until a fresh outline is taken, which is what the
 * message says to do.
 */
export class StaleSnapshotError extends CdpError {}

/**
 * Why a held outline id can no longer be acted on, or undefined when it can.
 *
 * Three cases, named so the agent knows which: no outline yet, a newer outline exists,
 * or this outline's page has re-rendered underneath it.
 */
export function staleReason(
  claimed: string | undefined,
  current: string | undefined,
  mutations: number
): string | undefined {
  if (claimed === undefined) return undefined;
  if (current === undefined) {
    return `STALE_SNAPSHOT: no outline has been taken of this page yet, so ${claimed} cannot be from it. Take a browser_snapshot first.`;
  }
  if (claimed !== current) {
    return `STALE_SNAPSHOT: you are holding ${claimed}, but the latest outline of this page is ${current}. Take a fresh browser_snapshot and use a ref from it.`;
  }
  if (mutations > STALE_MUTATIONS) {
    return `STALE_SNAPSHOT: the page has changed since ${claimed} (${mutations} elements added or removed), so its refs may point at different things now. Take a fresh browser_snapshot.`;
  }
  return undefined;
}

/**
 * The click would do something a person has to say yes to.
 *
 * Deterministic and outside the model, which is the point (docs/49 B1, huashu-chrome's
 * payment gate): a prompt can be talked out of caution by the page it is reading; a word
 * list in the box cannot. Answered as HTTP 428 so the host routes it to the policy gate
 * and comes back with `confirmed` once a person has read what it is.
 */
export class IrreversibleActionError extends CdpError {}

/** What the box reads off a click target before deciding whether to ask. */
export interface ClickTarget {
  /** The button's own words: aria-label, value, or text. */
  text: string;
  /** Role or tag, for the message. */
  role?: string;
  /** The text of the form, dialog or section the target sits in, for the money check. */
  nearby: string;
}

const PAY_WORDS =
  /\b(pay(?: now)?|checkout|check out|place (?:your )?order|buy now|purchase|subscribe|confirm (?:order|purchase|payment)|transfer|withdraw|top up)\b|支付|付款|立即购买|下单|结算|购买|订购|充值|转账|提现|续费/i;
const PUBLISH_WORDS = /\b(publish|go live|post now)\b|发布|上线|投稿/i;
const DELETE_WORDS =
  /\b(delete|remove|destroy|erase|wipe|uninstall|deactivate|close (?:my )?account|permanently)\b|删除|移除|清空|销毁|注销|永久/i;
const AUTHORIZE_WORDS = /\b(authori[sz]e|grant access|allow access|connect account|approve)\b|授权|允许访问|绑定/i;
/** A generic yes, which means whatever the surrounding text says it means. */
const GENERIC_YES = /^\s*(ok|okay|yes|confirm|continue|proceed|确认|确定|继续|好的|是)\s*$/i;
const MONEY =
  /(?:[¥￥$€£]|\b(?:RMB|CNY|USD|EUR|GBP)\b)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:元|美元|欧元|英镑|块钱|USD|CNY|RMB)\b/i;

/**
 * Why a click needs a person, or undefined when it does not.
 *
 * Four families by the target's own words, plus the shape the words miss: a bare
 * "Confirm" or "OK" whose form shows an amount. Send and submit are deliberately absent —
 * they are most of what a bot does all day, and a gate that fires on every message is a
 * gate people switch off.
 */
export function irreversibleReason(target: ClickTarget): string | undefined {
  const words = target.text.trim();
  if (words === "") return undefined;
  const what = `${target.role ?? "element"} ${JSON.stringify(words.slice(0, 60))}`;
  if (PAY_WORDS.test(words)) return `pay or order: click ${what}`;
  if (PUBLISH_WORDS.test(words)) return `publish: click ${what}`;
  if (DELETE_WORDS.test(words)) return `delete or remove: click ${what}`;
  if (AUTHORIZE_WORDS.test(words)) return `authorise or grant access: click ${what}`;
  if (GENERIC_YES.test(words)) {
    const amount = MONEY.exec(target.nearby);
    if (amount !== null) {
      return `confirm with money on the page: click ${what} next to ${JSON.stringify(amount[0].trim())}`;
    }
  }
  return undefined;
}

/** What the target looks like, before and after an action, for `judgeEffect`. */
export interface TargetState {
  value?: string;
  checked?: boolean;
  text: string;
  focused: boolean;
  aria: string;
  /** A cheap fingerprint of the target's subtree. */
  subtree: string;
  disabled: boolean;
}

/**
 * Did the action change its target (INV-399, huashu-chrome's effect evidence)?
 *
 * `after` undefined means the element is gone — which for a dismissed dialog or a deleted
 * row is the strongest confirmation there is. A navigation is a change too. Only focus
 * moving is "partial": the click landed, the page did nothing with it yet. Nothing
 * changing is a suspected no-op: the page painted the text and the app did not take it,
 * or the click was swallowed. Global text length is deliberately not evidence.
 */
export function judgeEffect(
  before: TargetState,
  after: TargetState | undefined,
  navigated: boolean
): { effect: Effect; changed: string[] } {
  const changed: string[] = [];
  if (navigated) changed.push("navigated");
  if (after === undefined) {
    changed.push("gone");
    return { effect: "confirmed", changed };
  }
  if (before.value !== after.value) changed.push("value");
  if (before.checked !== after.checked) changed.push("checked");
  if (before.text !== after.text) changed.push("text");
  if (before.aria !== after.aria) changed.push("aria");
  if (before.disabled !== after.disabled) changed.push("disabled");
  if (before.subtree !== after.subtree) changed.push("subtree");
  if (before.focused !== after.focused) changed.push("focus");
  const substantive = changed.filter(what => what !== "focus");
  if (substantive.length > 0) return { effect: "confirmed", changed };
  if (changed.length > 0) return { effect: "partial", changed };
  return { effect: "suspected_noop", changed };
}

/**
 * Whether the page became what the agent meant. Undefined when it did; otherwise one
 * sentence naming the first expectation that failed, with what was found.
 */
export function unmetExpectation(
  expect: ActExpectation | undefined,
  after: TargetState | undefined,
  pageText: string
): string | undefined {
  if (expect === undefined) return undefined;
  if (expect.gone === true && after !== undefined) return "expected the element to be gone, and it is still on the page";
  if (expect.gone === false && after === undefined) return "expected the element to remain, and it is gone";
  if (after === undefined && (expect.value !== undefined || expect.text !== undefined || expect.checked !== undefined)) {
    return "expected to read the element afterwards, and it is gone from the page";
  }
  if (expect.value !== undefined && after !== undefined && (after.value ?? "") !== expect.value) {
    return `expected value ${JSON.stringify(expect.value)}, found ${JSON.stringify(after.value ?? "")}`;
  }
  if (expect.text !== undefined && after !== undefined && !after.text.toLowerCase().includes(expect.text.toLowerCase())) {
    return `expected the element's text to contain ${JSON.stringify(expect.text)}, found ${JSON.stringify(after.text.slice(0, 80))}`;
  }
  if (expect.checked !== undefined && after !== undefined && after.checked !== expect.checked) {
    return `expected checked=${expect.checked}, found checked=${String(after.checked)}`;
  }
  if (expect.appears !== undefined && !pageText.toLowerCase().includes(expect.appears.toLowerCase())) {
    return `expected ${JSON.stringify(expect.appears)} to appear on the page, and it did not`;
  }
  return undefined;
}

/**
 * Whether a page's host is one a secret may be typed into: exact, or `*.example.com`
 * for the domain and its subdomains. An empty list allows nothing — a credential with no
 * home is fillable nowhere.
 */
export function hostAllowed(host: string, domains: readonly string[]): boolean {
  const target = host.trim().toLowerCase();
  if (target === "") return false;
  return domains.some(entry => {
    const pattern = entry.trim().toLowerCase();
    if (pattern === "") return false;
    if (pattern.startsWith("*.")) {
      const bare = pattern.slice(2);
      return target === bare || target.endsWith(`.${bare}`);
    }
    return target === pattern;
  });
}

export interface BrowserResult {
  url: string;
  title: string;
  snapshot: string;
  /** The id of this outline; act with a ref from it and say so. */
  snapshot_id?: string;
  /** For an act on a ref: whether the target changed, and how (INV-399). */
  effect?: Effect;
  changed?: string[];
  /** Set when a page asked a question while we were acting, and how it was answered. */
  dialog?: string;
  /** Set when something went wrong in a way the agent can act on. */
  note?: string;
  /** See `Outcome` in the protocol. Absent means ok. */
  outcome?: Outcome;
  /** For a wait: held, never held, or could not be checked. */
  wait?: WaitOutcome;
}

/**
 * What a wait concludes from how it ended.
 *
 * A probe that threw — the page was navigating, the execution context was torn down —
 * tells us nothing about whether the condition holds, and reporting that as "never
 * contained" sent agents off to fix pages that were merely mid-load. Only a probe that
 * *ran* and came back without the value is a real "no".
 */
export function waitOutcome(met: boolean, lastProbeFailed: boolean): WaitOutcome {
  if (met) return "satisfied";
  return lastProbeFailed ? "unknown" : "unsatisfied";
}

/** The sentence the agent reads before the page, for each way a wait can end. */
export function waitNote(
  kind: string,
  value: string,
  waitedMs: number,
  outcome: WaitOutcome,
  probeError?: string
): string {
  const shown = JSON.stringify(value);
  switch (outcome) {
    case "satisfied":
      return `The ${kind} contained ${shown} after ${Math.round(waitedMs / 100) / 10}s.`;
    case "unsatisfied":
      return (
        `Waited ${Math.round(waitedMs / 1000)}s and the ${kind} never contained ${shown}. ` +
        "The page as it stands is below."
      );
    case "unknown":
      return (
        `Waited ${Math.round(waitedMs / 1000)}s and could not tell whether the ${kind} ` +
        `contained ${shown}: the page could not be read (${probeError ?? "no reason given"}). ` +
        "That is not a no. Look at the page below before acting."
      );
  }
}

interface FrameContext {
  /** Empty for the main frame; "@f<hash>" for the rest, which is what qualifies a ref. */
  suffix: string;
  /** Absent for a cross-origin frame, whose contents this session cannot reach. */
  contextId?: number;
  url: string;
}

/**
 * A frame's handle, derived from its address rather than its position.
 *
 * Numbering frames by enumeration order is the same mistake element refs used to make:
 * an advertisement iframe appearing shifts every later frame, and a ref an agent is
 * holding quietly comes to mean a different document. Derived from the URL, `@f3k2s` is
 * the same frame in the next snapshot or it is gone.
 */
function frameSuffix(url: string): string {
  let hash = 2166136261;
  for (let index = 0; index < url.length; index++) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `@f${hash.toString(36).slice(0, 4)}`;
}

/**
 * One live connection to one page on one desktop.
 *
 * Held open between calls because the ref map and the armed dialog handler both live for
 * exactly as long as the connection does.
 */
class BrowserPage {
  private readonly contexts = new Map<string, number>();
  private frames: FrameContext[] = [];
  private snapshotSeq = 0;
  /** The id of the last outline taken, or undefined before the first. */
  snapshotId: string | undefined;
  private lastDialog: string | undefined;
  lastDownload: string | undefined;
  private loaded = false;
  private navigating = false;
  private mainFrameId: string | undefined;

  private constructor(
    readonly session: CdpSession,
    readonly port: number
  ) {}

  static async attach(port: number, target: CdpTarget): Promise<BrowserPage> {
    const session = await CdpSession.open(target);
    const page = new BrowserPage(session, port);

    session.on("Runtime.executionContextCreated", params => {
      const context = params.context as { id: number; auxData?: { frameId?: string } };
      if (context.auxData?.frameId !== undefined) {
        page.contexts.set(context.auxData.frameId, context.id);
      }
    });
    session.on("Runtime.executionContextsCleared", () => page.contexts.clear());
    session.on("Page.frameStartedLoading", params => {
      if (params.frameId === page.mainFrameId) {
        page.navigating = true;
        page.loaded = false;
      }
    });
    session.on("Page.loadEventFired", () => {
      page.loaded = true;
      page.navigating = false;
    });
    // The events fire whether or not anyone is listening, so a download used to produce
    // no navigation, no DOM change, an identical snapshot and no note — and the agent,
    // reasonably concluding the click did nothing, clicked again.
    session.on("Page.downloadWillBegin", params => {
      const name = String(params.suggestedFilename ?? "a file");
      page.lastDownload = `The page started downloading ${name}. It is going to the browser's download directory, and your file tools can read it once it has finished.`;
    });
    session.on("Page.javascriptDialogOpening", params => {
      void page.answerDialog(params as { message?: string; type?: string });
    });

    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("DOM.enable");
    const tree = (await session.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
    // Needed to tell "the page is navigating" from "an advert in an iframe is loading",
    // which otherwise makes every action on an ad-supported page wait for the ads.
    page.mainFrameId = tree.frameTree.frame.id;
    return page;
  }

  private async answerDialog(params: { message?: string; type?: string }): Promise<void> {
    const { accept, note } = dialogAnswer(params.type ?? "confirm", params.message ?? "");
    this.lastDialog = note;
    try {
      await this.session.send("Page.handleJavaScriptDialog", { accept });
    } catch {
      // The dialog may have gone on its own; nothing useful to do about it.
    }
  }

  /**
   * Waits for a page to stop moving, without insisting that it ever fully loads.
   *
   * The waiting is conditional on a navigation actually having started, and that is the
   * whole point of this method. Waiting for a load event unconditionally is the obvious
   * version and costs fifteen seconds on every click that stays on the page — which is
   * most clicks. Measured at 15.9s per click before this existed.
   */
  private async settle(expectNavigation: boolean): Promise<void> {
    const waitUntil = async (done: () => boolean, limitMs: number): Promise<boolean> => {
      const deadline = Date.now() + limitMs;
      while (!done() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return done();
    };

    // After a click or a keypress we do not know yet whether the page is going anywhere.
    // Give it a moment to say so, and if it says nothing, it is not.
    const going =
      expectNavigation ||
      this.navigating ||
      (await waitUntil(() => this.navigating || this.loaded, NAVIGATION_GRACE_MS));

    if (going) {
      // A load that never fires is normal on pages that stream forever; the snapshot is
      // taken of whatever is there rather than failing, because a partial page is usually
      // workable and an error is not.
      await waitUntil(() => this.loaded, LOAD_TIMEOUT_MS);
    }
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
    await this.waitForContent();
  }

  /**
   * Waits for the page to stop growing, not merely to finish loading.
   *
   * The load event means the document arrived, which on a modern site means the shell
   * arrived: navigation, a search box, and nothing else. Content comes afterwards, by
   * script. A snapshot taken at the load event plus a fixed pause catches the shell — and
   * an agent handed the shell of a search page reasonably concludes there were no results.
   *
   * That is not hypothetical. An agent searched for a real product, was handed a page
   * containing the search box and the navigation, and reported that the part did not
   * exist. The results were there a second later.
   *
   * Two consecutive samples of the same size mean the page has settled. Cheap — it is one
   * small evaluate per sample — and it stops early, so a page that was already complete
   * pays one round trip.
   */
  private async waitForContent(): Promise<void> {
    const deadline = Date.now() + CONTENT_SETTLE_MAX_MS;
    let previous = -1;
    let samples = 0;
    while (Date.now() < deadline) {
      let size = 0;
      try {
        const result = (await this.session.send("Runtime.evaluate", {
          expression: "(document.body && document.body.innerText || '').length",
          returnByValue: true,
        })) as { result?: { value?: number } };
        size = Number(result.result?.value ?? 0);
      } catch {
        return;
      }
      samples += 1;
      // Stable *and* has something on it — a page mid-load is briefly empty, and settling
      // instantly at zero would learn nothing. But a viewer page (a PDF, an image) has an
      // empty body for ever, so an empty page that has stayed empty for a few samples has
      // told us what it is going to tell us; without this it burned the whole budget on
      // every PDF.
      if (size === previous && (size > 0 || samples >= EMPTY_SETTLE_SAMPLES)) return;
      previous = size;
      await new Promise(resolve => setTimeout(resolve, CONTENT_POLL_MS));
    }
  }

  private async frameTree(): Promise<FrameContext[]> {
    const tree = (await this.session.send("Page.getFrameTree")) as {
      frameTree: { frame: { id: string; url: string }; childFrames?: FrameNode[] };
    };
    const found: FrameContext[] = [];
    const main = this.contexts.get(tree.frameTree.frame.id);
    if (main !== undefined) found.push({ suffix: "", contextId: main, url: tree.frameTree.frame.url });

    // Recursive: only the top level was walked, so a frame inside a frame — which is what
    // a payment form inside a checkout widget is — was missing entirely and silently.
    const descend = (nodes: FrameNode[]): void => {
      for (const child of nodes) {
        const contextId = this.contexts.get(child.frame.id);
        found.push({
          suffix: frameSuffix(child.frame.url),
          ...(contextId !== undefined ? { contextId } : {}),
          url: child.frame.url,
        });
        descend(child.childFrames ?? []);
      }
    };
    descend(tree.frameTree.childFrames ?? []);
    return found;
  }

  /**
   * Reads the page, and every frame in it, as one outline.
   *
   * Frames are appended under a heading rather than spliced into the parent at the point
   * the iframe sits. Splicing needs the iframe element correlated to its frame through
   * three more CDP round trips, and buys only the position — the contents, which is what
   * an agent acts on, are the same either way.
   */
  async snapshot(): Promise<{ text: string; url: string; title: string }> {
    this.frames = await this.frameTree();
    const parts: string[] = [];
    let budget = MAX_NODES;
    for (const frame of this.frames) {
      // A frame with no execution context is cross-origin and out of process: its
      // contents are unreachable from this session. Said out loud rather than skipped,
      // because a checkout page whose card fields are simply absent is a page an agent
      // reasons about the absence of.
      if (frame.contextId === undefined) {
        parts.push(`\n[frame ${frame.suffix.slice(1)} (${frame.url}) is cross-origin; its contents cannot be read from here. Open it directly if you need what is inside.]`);
        continue;
      }
      if (budget <= 0) {
        parts.push("\n(the rest of this page's frames were not read — the outline is full)");
        break;
      }
      const result = (await this.session.send("Runtime.evaluate", {
        expression: snapshotScript(budget),
        contextId: frame.contextId,
        returnByValue: true,
      })) as { result?: { value?: string }; exceptionDetails?: unknown };
      if (result.exceptionDetails !== undefined) continue;
      const body = (result.result?.value ?? "").trim();
      if (body === "") continue;
      budget -= body.split("\n").length;
      if (frame.suffix === "") {
        parts.push(body);
      } else {
        // Refs are numbered per frame, so e1 in a frame is a different element from e1 in
        // the page. The suffix is what makes a ref mean one thing.
        const qualified = body.replace(/\[ref=(e[0-9a-z]+)\]/gi, `[ref=$1${frame.suffix}]`);
        parts.push(`\nFrame ${frame.suffix.slice(1)} (${frame.url}):\n${qualified}`);
      }
    }
    const info = (await this.session.send("Runtime.evaluate", {
      expression:
        "JSON.stringify({url: location.href, title: document.title, type: document.contentType," +
        " y: Math.round(scrollY), h: Math.round(document.documentElement.scrollHeight)," +
        " v: Math.round(innerHeight)})",
      returnByValue: true,
    })) as { result?: { value?: string } };
    const parsed = JSON.parse(info.result?.value ?? '{"url":"","title":""}') as {
      url: string;
      title: string;
      type?: string;
      y?: number;
      h?: number;
      v?: number;
    };

    // A PDF, an image or a video renders in a viewer with an empty body, so the outline
    // is empty and the honest-looking answer — "nothing to act on" — reads as "this page
    // is blank". Naming what it actually is stops the agent reasoning about an absence.
    // Every outline gets a new id, viewer pages included: an id is what a ref is dated by.
    this.snapshotSeq += 1;
    this.snapshotId = `s${this.snapshotSeq}`;

    if (parsed.type !== undefined && !/html|xml/i.test(parsed.type) && parts.length === 0) {
      return {
        text: `(this is ${parsed.type}, not a web page — the browser is displaying it in a viewer, so there is nothing to act on. Download it and read it with your file tools instead.)`,
        url: parsed.url,
        title: parsed.title,
      };
    }

    // Where we are in the page, which the outline alone cannot say. Without it, a feed
    // longer than the node cap returns a byte-identical outline after every scroll, and
    // the agent correctly concludes nothing more is loading — which is false.
    const position =
      parsed.h !== undefined && parsed.v !== undefined && parsed.h > parsed.v + 4
        ? `(showing ${parsed.y}–${(parsed.y ?? 0) + parsed.v} of ${parsed.h} pixels; scroll for more)\n`
        : "";
    return {
      text: position + (parts.join("\n") || "(the page has nothing to act on)"),
      url: parsed.url,
      title: parsed.title,
    };
  }

  /** Turns a ref back into a live element handle, in whichever frame owns it. */
  private async resolve(ref: string): Promise<string> {
    const match = /^(e[0-9a-z]+)(@f[0-9a-z]+)?$/i.exec(ref.trim());
    if (match === null) {
      throw new CdpError(`"${ref}" is not a ref. Refs look like e1k4t, or e1k4t@f1 inside a frame.`);
    }
    const suffix = match[2] ?? "";
    const frame = this.frames.find(candidate => candidate.suffix === suffix);
    if (frame === undefined) {
      throw new CdpError(`No frame ${suffix || "(main)"} in the last snapshot. Take a fresh one.`);
    }
    const result = (await this.session.send("Runtime.evaluate", {
      expression: `globalThis.__lumenRefs && globalThis.__lumenRefs.get(${JSON.stringify(match[1])})`,
      contextId: frame.contextId,
    })) as { result?: { objectId?: string; subtype?: string } };
    if (result.result?.objectId === undefined) {
      throw new CdpError(
        `Ref ${ref} is not on this page any more. Take a fresh browser_snapshot and use a ref from it.`
      );
    }
    return result.result.objectId;
  }

  /**
   * Where on the screen an element is, in the page's own coordinates.
   *
   * Through the DOM domain rather than getBoundingClientRect, because an element inside an
   * iframe reports its position relative to that frame — and the mouse event we are about
   * to send is in the page's coordinates. This returns the latter for both.
   */
  private async centreOf(objectId: string): Promise<{ x: number; y: number }> {
    await this.session.send("DOM.scrollIntoViewIfNeeded", { objectId }).catch(() => {});
    // By objectId, not nodeId. A nodeId only exists once DOM.getDocument has walked the
    // page and handed them out, so going through requestNode means either fetching the
    // whole document first or being told "could not find node with given id" — which is
    // what happened. The box model takes the handle we already hold.
    const box = (await this.session.send("DOM.getBoxModel", { objectId })) as {
      model?: { content: number[] };
    };
    const quad = box.model?.content;
    if (quad === undefined || quad.length < 8) {
      throw new CdpError("That element has no position on the page, so it cannot be clicked.");
    }
    return {
      x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
      y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
    };
  }

  async click(ref: string, confirmed = false): Promise<void> {
    const objectId = await this.resolve(ref);
    const { x, y } = await this.centreOf(objectId);

    // Before anything is dispatched: what the click would do. A person's consent is asked
    // for by the host on a 428, and the same call comes back with `confirmed`.
    if (!confirmed) {
      const reason = irreversibleReason(await this.describeTarget(objectId));
      if (reason !== undefined) throw new IrreversibleActionError(`IRREVERSIBLE: ${reason}`);
    }

    // What is actually on top at that point. A cookie wall or a modal changes none of the
    // things visibility is tested on — it is not hidden, the element under it still has a
    // box — so the click dispatches at real coordinates and the overlay receives it, with
    // nothing anywhere reporting the difference. This is the failure behind every "the
    // agent kept clicking and nothing happened" on a consent-walled site.
    //
    // Main frame only: the box model is in page coordinates while elementFromPoint inside
    // a frame is in that frame's, and a wrong comparison would refuse valid clicks.
    if (!ref.includes("@")) {
      const covered = (await this.session.send("Runtime.callFunctionOn", {
        objectId,
        arguments: [{ value: x }, { value: y }],
        returnByValue: true,
        functionDeclaration:
          "function(x, y){ const hit = document.elementFromPoint(x, y);" +
          " if (!hit || hit === this || this.contains(hit) || hit.contains(this)) return '';" +
          " const name = hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '');" +
          " return name + ' ' + (hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60); }",
      })) as { result?: { value?: string } };
      const blocker = covered.result?.value ?? "";
      if (blocker !== "") {
        throw new CdpError(
          `That click would land on "${blocker}" instead — something is covering the ` +
            `element. Deal with what is on top first (a cookie banner, a modal, a sticky ` +
            `header), then try again.`
        );
      }
    }

    this.loaded = false;
    // A real mouse event rather than element.click(), so hover states, focus and handlers
    // that check for a trusted-looking event all behave as they do for a person.
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await this.session.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
        buttons: type === "mousePressed" ? 1 : 0,
      });
    }
  }

  /** The target's state, for `judgeEffect` (INV-399). */
  async targetState(objectId: string): Promise<TargetState> {
    const described = (await this.session.send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration:
        "function(){ const t = this; const attrs = ['aria-expanded','aria-pressed','aria-selected','aria-checked','aria-disabled'];" +
        " const aria = attrs.map(a => a + '=' + (t.getAttribute ? (t.getAttribute(a) || '') : '')).join(';');" +
        " const html = t.outerHTML || ''; let h = 2166136261; for (let i = 0; i < html.length; i++) { h ^= html.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }" +
        " return JSON.stringify({ value: ('value' in t && typeof t.value === 'string') ? t.value : undefined," +
        "   checked: typeof t.checked === 'boolean' ? t.checked : undefined," +
        "   text: String(t.innerText || t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 400)," +
        "   focused: t.ownerDocument ? t.ownerDocument.activeElement === t : false, aria: aria," +
        "   subtree: html.length + ':' + h.toString(36), disabled: t.disabled === true }); }",
    })) as { result?: { value?: string } };
    const parsed = JSON.parse(described.result?.value ?? "{}") as Partial<TargetState>;
    return {
      value: parsed.value,
      checked: parsed.checked,
      text: parsed.text ?? "",
      focused: parsed.focused === true,
      aria: parsed.aria ?? "",
      subtree: parsed.subtree ?? "",
      disabled: parsed.disabled === true,
    };
  }

  /** The target's state after an action, or undefined when it left the page. */
  async targetStateAfter(ref: string): Promise<TargetState | undefined> {
    try {
      const objectId = await this.resolve(ref);
      return await this.targetState(objectId);
    } catch {
      return undefined;
    }
  }

  /** Whether the main frame started a navigation since the flag was last cleared. */
  get navigatedSince(): boolean {
    return this.navigating || !this.loaded;
  }

  /** The visible text of the page, for `expect.appears`. Bounded like read(). */
  async visibleText(): Promise<string> {
    try {
      const result = (await this.session.send("Runtime.evaluate", {
        expression: "document.body ? String(document.body.innerText || '').slice(0, 40000) : ''",
        returnByValue: true,
      })) as { result?: { value?: string } };
      return String(result.result?.value ?? "");
    } catch {
      return "";
    }
  }

  /** The object id of a ref, for a caller that wants the state before acting. */
  async objectOf(ref: string): Promise<string> {
    return this.resolve(ref);
  }

  /**
   * Types a vault secret into a field without the page's own scripts seeing the write
   * (INV-402, browser-use-pi's fillSecret; docs/15 design C).
   *
   * Main document only, and only on a host the secret names. The value is set in an
   * isolated world through the native setter — the page's monkey-patched `value` setter,
   * if it has one, never runs — then `input` and `change` are dispatched so the app takes
   * it, and the field is marked so the outline redacts it. Nothing here goes through
   * `Input.insertText`, so no keystroke reaches a recording.
   */
  async fillSecret(ref: string, value: string, domains: readonly string[]): Promise<void> {
    if (ref.includes("@")) {
      throw new CdpError("fill_secret works on the main document only; a field inside a frame cannot be filled this way.");
    }
    const objectId = await this.resolve(ref);
    const where = (await this.session.send("Runtime.evaluate", {
      expression: "location.host",
      returnByValue: true,
    })) as { result?: { value?: string } };
    const host = String(where.result?.value ?? "");
    if (!hostAllowed(host, domains)) {
      throw new CdpError(
        domains.length === 0
          ? `This secret names no domains it may be filled into, so it cannot be typed anywhere. An operator adds them in Settings → Vault.`
          : `This page is ${host || "(no host)"}, and the secret may only be filled into ${domains.join(", ")}.`
      );
    }
    if (this.mainFrameId === undefined) throw new CdpError("The page has no main frame to fill into yet; take a snapshot first.");
    const node = (await this.session.send("DOM.describeNode", { objectId })) as { node?: { backendNodeId?: number } };
    const backendNodeId = node.node?.backendNodeId;
    if (backendNodeId === undefined) throw new CdpError("That element cannot be addressed for a secret fill; take a fresh snapshot.");
    const world = (await this.session.send("Page.createIsolatedWorld", {
      frameId: this.mainFrameId,
      worldName: "lumenbox-secret",
    })) as { executionContextId?: number };
    if (world.executionContextId === undefined) throw new CdpError("Could not open an isolated world on this page.");
    const isolated = (await this.session.send("DOM.resolveNode", {
      backendNodeId,
      executionContextId: world.executionContextId,
    })) as { object?: { objectId?: string } };
    const target = isolated.object?.objectId;
    if (target === undefined) throw new CdpError("That element is not reachable from the isolated world; take a fresh snapshot.");
    const outcome = (await this.session.send("Runtime.callFunctionOn", {
      objectId: target,
      arguments: [{ value }],
      returnByValue: true,
      functionDeclaration:
        "function(v){ const proto = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;" +
        " const d = Object.getOwnPropertyDescriptor(proto, 'value'); if (!d || !d.set) return 'not a field';" +
        " this.focus(); d.set.call(this, v);" +
        " this.dispatchEvent(new Event('input', {bubbles:true})); this.dispatchEvent(new Event('change', {bubbles:true}));" +
        " this.setAttribute('data-lumen-secret', '1'); return 'ok'; }",
    })) as { result?: { value?: string } };
    if (outcome.result?.value !== "ok") {
      throw new CdpError(`That element is ${outcome.result?.value ?? "not fillable"}: fill_secret needs an input or a textarea.`);
    }
  }

  /** The target's own words and the text around it, for `irreversibleReason`. */
  private async describeTarget(objectId: string): Promise<ClickTarget> {
    const described = (await this.session.send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration:
        "function(){ const t = this;" +
        " const own = (t.getAttribute && (t.getAttribute('aria-label') || t.getAttribute('title'))) ||" +
        "   (t.tagName && t.tagName.toLowerCase() === 'input' ? t.value : '') || t.textContent || '';" +
        " const role = (t.getAttribute && t.getAttribute('role')) || (t.tagName || '').toLowerCase();" +
        " const scope = t.closest ? (t.closest('form,[role=dialog],dialog,[role=alertdialog],section,article,main') || t.parentElement) : null;" +
        " const nearby = scope ? (scope.innerText || scope.textContent || '') : '';" +
        " return JSON.stringify({ text: String(own).replace(/\\s+/g, ' ').trim().slice(0, 200)," +
        "   role: role, nearby: String(nearby).replace(/\\s+/g, ' ').trim().slice(0, 1500) }); }",
    })) as { result?: { value?: string } };
    try {
      const parsed = JSON.parse(described.result?.value ?? "{}") as Partial<ClickTarget>;
      return { text: parsed.text ?? "", role: parsed.role, nearby: parsed.nearby ?? "" };
    } catch {
      return { text: "", nearby: "" };
    }
  }

  async hover(ref: string): Promise<void> {
    const objectId = await this.resolve(ref);
    const { x, y } = await this.centreOf(objectId);
    await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  }

  async type(ref: string, text: string, replace: boolean): Promise<void> {
    const objectId = await this.resolve(ref);
    await this.session.send("DOM.focus", { objectId }).catch(async () => {
      // Not everything focusable through a click is focusable through DOM.focus. Confirmed:
      // the click is to focus a field, not to press what the field is.
      await this.click(ref, true);
    });
    if (replace) {
      await this.session.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          "function(){ if ('value' in this) { this.value = ''; " +
          "this.dispatchEvent(new Event('input', {bubbles:true})); } }",
      });
    }
    await this.session.send("Input.insertText", { text });
    // Frameworks that watch keystrokes rather than the value need to be told, or the page
    // shows the text while the application behind it believes the field is still empty.
    await this.session.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration:
        "function(){ this.dispatchEvent(new Event('input', {bubbles:true})); " +
        "this.dispatchEvent(new Event('change', {bubbles:true})); }",
    });
  }

  async press(key: string): Promise<void> {
    const known: Record<string, { code: string; keyCode: number; text?: string }> = {
      Enter: { code: "Enter", keyCode: 13, text: "\r" },
      Tab: { code: "Tab", keyCode: 9 },
      Escape: { code: "Escape", keyCode: 27 },
      Backspace: { code: "Backspace", keyCode: 8 },
      Delete: { code: "Delete", keyCode: 46 },
      ArrowUp: { code: "ArrowUp", keyCode: 38 },
      ArrowDown: { code: "ArrowDown", keyCode: 40 },
      ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
      ArrowRight: { code: "ArrowRight", keyCode: 39 },
      PageDown: { code: "PageDown", keyCode: 34 },
      PageUp: { code: "PageUp", keyCode: 33 },
      Home: { code: "Home", keyCode: 36 },
      End: { code: "End", keyCode: 35 },
    };
    const spec = known[key];
    if (spec === undefined) {
      throw new CdpError(`${key} is not a key this sends. Known: ${Object.keys(known).join(", ")}.`);
    }
    this.loaded = false;
    for (const type of ["keyDown", "keyUp"] as const) {
      await this.session.send("Input.dispatchKeyEvent", {
        type,
        key,
        code: spec.code,
        windowsVirtualKeyCode: spec.keyCode,
        nativeVirtualKeyCode: spec.keyCode,
        ...(type === "keyDown" && spec.text !== undefined ? { text: spec.text } : {}),
      });
    }
  }

  async scroll(direction: string, amount: number): Promise<void> {
    const distance = Math.max(1, Math.min(amount, 20)) * 100;
    const deltas: Record<string, { x: number; y: number }> = {
      down: { x: 0, y: distance },
      up: { x: 0, y: -distance },
      right: { x: distance, y: 0 },
      left: { x: -distance, y: 0 },
    };
    const delta = deltas[direction];
    if (delta === undefined) throw new CdpError(`Scroll direction must be up, down, left or right.`);
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 200,
      y: 300,
      deltaX: delta.x,
      deltaY: delta.y,
    });
  }

  async navigate(url: string): Promise<void> {
    this.loaded = false;
    const result = (await this.session.send("Page.navigate", { url })) as { errorText?: string };
    if (result.errorText !== undefined && result.errorText !== "") {
      throw new CdpError(`Could not open ${url}: ${result.errorText}`);
    }
  }

  /** Attaches a file already inside the box to a file input. */
  async upload(ref: string, files: string[]): Promise<void> {
    const objectId = await this.resolve(ref);
    await this.session.send("DOM.setFileInputFiles", { files, objectId });
  }

  /**
   * Waits for the page to say something, rather than for a fixed time.
   *
   * The fixed settle after an action is right for a page that finishes loading, and wrong
   * for the common modern shape where the load event fires and then the content arrives
   * by XHR. Without this an agent's only recourse is to snapshot repeatedly and hope,
   * which costs a round trip each time and still has no way to say what it is waiting for.
   */
  async waitFor(
    kind: string,
    value: string,
    timeoutMs: number
  ): Promise<{ met: boolean; waitedMs: number; probeError?: string }> {
    const started = Date.now();
    const probe: Record<string, string> = {
      text: "document.body ? document.body.innerText : ''",
      url: "location.href",
      title: "document.title",
    };
    const expression = probe[kind];
    if (expression === undefined) {
      throw new CdpError(`Wait for text, url or title — not ${JSON.stringify(kind)}.`);
    }
    const wanted = value.toLowerCase();
    // The last probe's failure, if it failed. A probe throws while the page is between
    // documents; that is not evidence the value is absent, and the caller must be told
    // the difference (`waitOutcome`).
    let probeError: string | undefined;
    while (Date.now() - started < timeoutMs) {
      try {
        const result = (await this.session.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
        })) as { result?: { value?: string } };
        probeError = undefined;
        const seen = String(result.result?.value ?? "").toLowerCase();
        // Contains rather than equals: a title gains suffixes, a URL gains query
        // parameters, and an agent that has to predict them exactly will not wait correctly.
        if (kind === "gone" ? !seen.includes(wanted) : seen.includes(wanted)) {
          return { met: true, waitedMs: Date.now() - started };
        }
      } catch (error) {
        probeError = error instanceof Error ? error.message : String(error);
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return { met: false, waitedMs: Date.now() - started, ...(probeError !== undefined ? { probeError } : {}) };
  }

  async read(): Promise<string> {
    const result = (await this.session.send("Runtime.evaluate", {
      expression: READ_SCRIPT,
      returnByValue: true,
    })) as { result?: { value?: string } };
    const text = result.result?.value ?? "";
    // Bounded like WebFetch is. The same content reached the model through two tools, one
    // of which had a limit and one of which did not, so a long article was affordable to
    // fetch and ruinous to read.
    return text.length > MAX_READ_CHARS
      ? `${text.slice(0, MAX_READ_CHARS)}\n\n[... the rest of the page is not shown]`
      : text;
  }

  /** Everything an action returns: what happened, then what the page looks like now. */
  async report(expectNavigation = false): Promise<BrowserResult> {
    await this.settle(expectNavigation);
    const { text, url, title } = await this.snapshot();
    const dialog = this.lastDialog;
    this.lastDialog = undefined;
    const download = this.lastDownload;
    this.lastDownload = undefined;
    return {
      url,
      title,
      snapshot: text,
      ...(this.snapshotId !== undefined ? { snapshot_id: this.snapshotId } : {}),
      ...(dialog !== undefined ? { dialog } : {}),
      ...(download !== undefined ? { note: download } : {}),
    };
  }

  /**
   * Refuses a ref taken from an outline the page has moved past.
   *
   * A ref is derived from what an element is, so it survives a re-render *when the
   * element does* — and quietly lands on the wrong one when a list re-sorted or a modal
   * replaced the page. The snapshot id plus the mutation count since it are what tell
   * those apart; a caller that names no id (an older host) is trusted as before.
   */
  async assertFresh(claimed: string | undefined): Promise<void> {
    if (claimed === undefined) return;
    let mutations = 0;
    if (this.snapshotId !== undefined && claimed === this.snapshotId) {
      const counted = (await this.session.send("Runtime.evaluate", {
        expression: MUTATIONS_SCRIPT,
        returnByValue: true,
      })) as { result?: { value?: number } };
      mutations = Number(counted.result?.value ?? 0);
    }
    const reason = staleReason(claimed, this.snapshotId, mutations);
    if (reason !== undefined) throw new StaleSnapshotError(reason);
  }

  /**
   * The ref of the element an agent describes, from the index the last outline left.
   *
   * Main frame only: the index is per document. Resolved now, against the page as it
   * stands, so it is the fallback when a held ref has gone stale.
   */
  async find(query: { role?: string; name?: string; nth?: number }): Promise<string> {
    const evaluated = (await this.session.send("Runtime.evaluate", {
      expression: findScript(query),
      returnByValue: true,
    })) as { result?: { value?: string } };
    const parsed = JSON.parse(evaluated.result?.value ?? "{}") as {
      ref?: string | null;
      count?: number;
      sample?: string[];
      error?: string;
    };
    const asked = JSON.stringify(query);
    if (parsed.error !== undefined) {
      throw new CdpError(`Nothing to find in yet: take a browser_snapshot first, then find ${asked}.`);
    }
    if (parsed.ref === null || parsed.ref === undefined) {
      const seen = parsed.sample && parsed.sample.length > 0 ? ` Matches: ${parsed.sample.join("; ")}.` : "";
      throw new CdpError(
        `No element matched find ${asked} (${parsed.count ?? 0} candidate(s)).${seen} ` +
          "Take a fresh browser_snapshot and look at the roles and names it lists."
      );
    }
    return parsed.ref;
  }

  close(): void {
    this.session.close();
  }
}

/**
 * The browser, per desktop.
 *
 * One page per desktop is deliberate. An agent has one desktop, and a browser that
 * silently accumulated tabs would make "the page" ambiguous in exactly the situation —
 * a click that opened something — where the agent most needs to know where it is.
 */
export class BrowserService {
  private readonly pages = new Map<number, BrowserPage>();
  /**
   * Which tabs we had already seen, per desktop, so a new one is recognisable as new.
   *
   * Without this a click that opens a tab — every `target="_blank"` link, and most OAuth
   * sign-ins — leaves the session looking at the old page, and the agent is told nothing
   * happened. It is the single most common way a real site defeats a bridge that only
   * ever holds one target.
   */
  private readonly knownTargets = new Map<number, Set<string>>();
  /** Something worth saying on the next result — that the tab changed under the agent. */
  private readonly pendingNote = new Map<number, string>();

  /**
   * Starts the browser on a desktop, and waits for it to be drivable.
   *
   * Because otherwise the first browser tool call on a fresh box fails with "no browser is
   * listening", and the agent has to know that the fix is `bash box-chrome &`. That is a
   * fact about this container, not about the task, and making the model carry it is how
   * turns get spent on setup. box-chrome rather than chromium: the wrapper holds the
   * sandbox, shared-memory and per-desktop profile flags, and the debugging port.
   */
  private async launch(display: number, port: number): Promise<void> {
    const child = spawn("box-chrome", ["about:blank"], {
      env: { ...process.env, DISPLAY: `:${display}` },
      detached: true,
      stdio: "ignore",
    });
    // Detached and unreferenced: the browser outlives this request on purpose, so that
    // logins and open tabs persist between turns the way a person's browser does.
    child.unref();

    const deadline = Date.now() + BROWSER_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 400));
      try {
        const targets = await listTargets(port);
        if (targets.length > 0) return;
      } catch {
        // Not up yet. The deadline is the only thing that decides to give up.
      }
    }
    throw new CdpError(
      `The browser did not start on desktop ${display} within ` +
        `${BROWSER_START_TIMEOUT_MS / 1000}s. Try \`box-doctor\` to see what is wrong with the box.`
    );
  }

  private async pageFor(display: number, openAt?: string): Promise<BrowserPage> {
    const existing = this.pages.get(display);
    if (existing?.session.isOpen) return existing;
    if (existing !== undefined) {
      this.pages.delete(display);
      // Said out loud rather than silently reattaching. An agent whose tab was closed and
      // who is quietly moved to a different page will keep acting as if it is where it was.
      this.pendingNote.set(
        display,
        "The tab you were using has gone, so you are now on whatever else is open. " +
          "Check the page below before acting on it."
      );
    }

    const port = portForDisplay(display);
    let targets: CdpTarget[];
    try {
      targets = await listTargets(port);
    } catch {
      await this.launch(display, port);
      targets = await listTargets(port);
    }
    const pages = targets.filter(target => target.type === "page");
    // Reuse whatever is already open, so an agent that navigated by hand and then asked
    // for a snapshot gets the page it is looking at rather than a fresh blank one.
    const target =
      pages.find(candidate => candidate.url !== "about:blank") ??
      pages[0] ??
      (await openTarget(port, openAt ?? "about:blank"));
    const page = await BrowserPage.attach(port, target);
    this.pages.set(display, page);
    // Everything open now counts as already seen, so only tabs opened after this point
    // are treated as popups to follow.
    this.knownTargets.set(display, new Set(targets.map(candidate => candidate.id)));
    return page;
  }

  /**
   * Follows a tab the page just opened, if it opened one.
   *
   * Polled rather than driven by Target events: this session is attached to a page, not to
   * the browser, so it is not told about targets it does not own. One extra HTTP call to
   * the browser's own listing per action is a cheap way to stop missing every popup.
   */
  private async adoptPopup(display: number): Promise<BrowserResult | undefined> {
    const port = portForDisplay(display);
    let targets: CdpTarget[];
    try {
      targets = (await listTargets(port)).filter(target => target.type === "page");
    } catch {
      return undefined;
    }
    const seen = this.knownTargets.get(display) ?? new Set<string>();
    const fresh = targets.filter(target => !seen.has(target.id));
    this.knownTargets.set(display, new Set(targets.map(target => target.id)));
    const opened = fresh[fresh.length - 1];
    if (opened === undefined) return undefined;

    this.pages.get(display)?.close();
    const page = await BrowserPage.attach(port, opened);
    this.pages.set(display, page);
    const result = await page.report(true);
    return {
      ...result,
      note:
        "That opened a new tab and you are now on it. The refs below are its own; the " +
        "page you came from is still open behind it.",
    };
  }

  /** Runs an action, then follows any tab it opened, and carries any pending note. */
  private async settled(display: number, result: BrowserResult): Promise<BrowserResult> {
    const adopted = await this.adoptPopup(display);
    const final = adopted ?? result;
    const note = this.pendingNote.get(display);
    this.pendingNote.delete(display);
    if (note === undefined) return final;
    return { ...final, note: final.note === undefined ? note : `${note} ${final.note}` };
  }

  async open(display: number, url: string): Promise<BrowserResult> {
    const page = await this.pageFor(display, url);
    await page.navigate(url);
    return this.settled(display, await page.report(true));
  }

  async snapshot(display: number): Promise<BrowserResult> {
    const page = await this.pageFor(display);
    return this.settled(display, await page.report());
  }

  async read(display: number): Promise<{ text: string; url: string }> {
    const page = await this.pageFor(display);
    const text = await page.read();
    const { url } = await page.snapshot();
    return { text, url };
  }

  async act(
    display: number,
    action: string,
    options: {
      ref?: string;
      text?: string;
      key?: string;
      replace?: boolean;
      snapshot?: string;
      find?: { role?: string; name?: string; nth?: number };
      confirmed?: boolean;
      expect?: ActExpectation;
    }
  ): Promise<BrowserResult> {
    const page = await this.pageFor(display);
    const needsRef = action === "click" || action === "type" || action === "hover";
    let ref = options.ref;
    if (needsRef) {
      if (options.find !== undefined) {
        // By description, against the page as it stands: nothing held, nothing stale.
        ref = await page.find(options.find);
      } else if (ref === undefined || ref === "") {
        throw new CdpError(
          `${action} needs the ref of the thing to act on, from a snapshot — or a find {role, name, nth} describing it.`
        );
      } else {
        await page.assertFresh(options.snapshot);
      }
    }
    // The target before, for the effect judgement (INV-399). Read after the stale check and
    // the find, so it is the element that will be acted on; a target that cannot be read is
    // simply unmeasured, never a refusal.
    const before = needsRef && ref !== undefined ? await page.targetStateAfter(ref) : undefined;
    switch (action) {
      case "click":
        await page.click(ref!, options.confirmed === true);
        break;
      case "hover":
        await page.hover(ref!);
        break;
      case "type":
        await page.type(ref!, options.text ?? "", options.replace !== false);
        break;
      case "key":
        await page.press(options.key ?? "Enter");
        break;
      default:
        throw new CdpError(`${action} is not something this does: click, type, key or hover.`);
    }
    const navigated = page.navigatedSince;
    const result = await this.settled(display, await page.report());
    if (before === undefined || ref === undefined) {
      if (options.expect !== undefined) {
        const unmet = unmetExpectation(options.expect, undefined, await page.visibleText());
        if (unmet !== undefined && options.expect.appears !== undefined) throw new CdpError(`The page is not what you expected: ${unmet}.`);
      }
      return result;
    }
    const after = await page.targetStateAfter(ref);
    const judged = judgeEffect(before, after, navigated);
    const unmet = unmetExpectation(options.expect, after, options.expect?.appears !== undefined ? await page.visibleText() : "");
    if (unmet !== undefined) {
      throw new CdpError(`The page is not what you expected: ${unmet}. (Effect: ${judged.effect}${judged.changed.length > 0 ? `, changed ${judged.changed.join(", ")}` : ""}.)`);
    }
    return { ...result, effect: judged.effect, changed: judged.changed };
  }

  /** Fills a vault secret into a field (INV-402). The value is never in the result. */
  async fillSecret(display: number, ref: string, value: string, domains: readonly string[], snapshot?: string): Promise<BrowserResult> {
    if (ref === "") throw new CdpError("fill_secret needs the ref of the field, from a snapshot.");
    if (value === "") throw new CdpError("The secret resolved to nothing; nothing was typed.");
    const page = await this.pageFor(display);
    await page.assertFresh(snapshot);
    await page.fillSecret(ref, value, domains);
    return this.settled(display, await page.report());
  }

  async scroll(display: number, direction: string, amount: number): Promise<BrowserResult> {
    const page = await this.pageFor(display);
    await page.scroll(direction, amount);
    return this.settled(display, await page.report());
  }

  async upload(display: number, ref: string, files: string[]): Promise<BrowserResult> {
    if (files.length === 0) throw new CdpError("Name a file inside your box to upload.");
    for (const file of files) {
      const refusal = checkUpload(file);
      if (refusal !== undefined) throw new CdpError(refusal);
    }
    const page = await this.pageFor(display);
    await page.upload(ref, files);
    return this.settled(display, await page.report());
  }

  /** Waits for the page to say something, and reports whether it did. */
  async waitFor(
    display: number,
    kind: string,
    value: string,
    seconds?: number
  ): Promise<BrowserResult> {
    const page = await this.pageFor(display);
    const limit = Math.min(Math.max((seconds ?? WAIT_DEFAULT_MS / 1000) * 1000, 500), WAIT_MAX_MS);
    const { met, waitedMs, probeError } = await page.waitFor(kind, value, limit);
    const outcome = waitOutcome(met, probeError !== undefined);
    const result = await page.report();
    return {
      ...result,
      // Reported either way rather than thrown on timeout: the page below is the answer to
      // "what happened instead", and an agent that only gets an error has to ask again.
      note: waitNote(kind, value, waitedMs, outcome, probeError),
      wait: outcome,
      // A wait that could not be checked is an unknown result, not a failed one: the
      // page may well say what was asked, and the agent has to look rather than retry.
      outcome: outcome === "unknown" ? "unknown" : "ok",
    };
  }

  /**
   * Opens a page in a tab of its own, reads it, and closes it again.
   *
   * For checking that the browser works after an upgrade, which must not be done by
   * driving the browser somebody is using. The obvious implementation reused the current
   * tab, and so every upgrade navigated whatever an agent had open away to the check page
   * and left it there — which is how "lumenbox upgrade check" started turning up on
   * people's screens.
   *
   * Deliberately outside the session bookkeeping: no page is remembered, no known-target
   * set is touched, so the tab this opens is not mistaken for a popup to follow.
   */
  async check(display: number, url: string): Promise<{ snapshot: string; title: string }> {
    const port = portForDisplay(display);
    // Started if it is not up. A freshly recreated box has no browser at all, which is
    // exactly when this runs — going straight to openTarget failed there, and the upgrade
    // rolled back a working image because the *check* was broken rather than the box.
    try {
      await listTargets(port);
    } catch {
      await this.launch(display, port);
    }
    const target = await openTarget(port, url);
    let page: BrowserPage | undefined;
    try {
      page = await BrowserPage.attach(port, target);
      const result = await page.report(true);
      return { snapshot: result.snapshot, title: result.title };
    } finally {
      page?.close();
      // Closed even when the check failed: a failed upgrade should not also leave a tab
      // behind on somebody's desktop.
      await closeTarget(port, target.id);
      // The tab existed while a popup sweep might have seen it, so it is registered as
      // already-known rather than left to look new on the next action.
      this.knownTargets.get(display)?.add(target.id);
    }
  }

  /** Drops the connection for a desktop, so the next call attaches afresh. */
  release(display: number): void {
    this.pages.get(display)?.close();
    this.pages.delete(display);
  }

  closeAll(): void {
    for (const display of [...this.pages.keys()]) this.release(display);
  }
}
