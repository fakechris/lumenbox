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

import { spawn } from "node:child_process";
import { CdpError, CdpSession, listTargets, openTarget, type CdpTarget } from "./cdp.ts";
import { READ_SCRIPT, SNAPSHOT_SCRIPT } from "./browser-snapshot.ts";

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
/** How long to wait for a browser we started to become drivable. */
const BROWSER_START_TIMEOUT_MS = 30_000;

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

export interface BrowserResult {
  url: string;
  title: string;
  snapshot: string;
  /** Set when a page asked a question while we were acting, and how it was answered. */
  dialog?: string;
  /** Set when something went wrong in a way the agent can act on. */
  note?: string;
}

interface FrameContext {
  /** Empty for the main frame; "f1", "f2"… for children, which is what qualifies a ref. */
  suffix: string;
  contextId: number;
  url: string;
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
  private lastDialog: string | undefined;
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
  }

  private async frameTree(): Promise<FrameContext[]> {
    const tree = (await this.session.send("Page.getFrameTree")) as {
      frameTree: {
        frame: { id: string; url: string };
        childFrames?: { frame: { id: string; url: string } }[];
      };
    };
    const found: FrameContext[] = [];
    const main = this.contexts.get(tree.frameTree.frame.id);
    if (main !== undefined) found.push({ suffix: "", contextId: main, url: tree.frameTree.frame.url });
    let index = 0;
    for (const child of tree.frameTree.childFrames ?? []) {
      index += 1;
      const contextId = this.contexts.get(child.frame.id);
      // A frame with no execution context has not run yet; it will appear on the next
      // snapshot rather than being reported as an error now.
      if (contextId !== undefined) {
        found.push({ suffix: `@f${index}`, contextId, url: child.frame.url });
      }
    }
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
    for (const frame of this.frames) {
      const result = (await this.session.send("Runtime.evaluate", {
        expression: SNAPSHOT_SCRIPT,
        contextId: frame.contextId,
        returnByValue: true,
      })) as { result?: { value?: string }; exceptionDetails?: unknown };
      if (result.exceptionDetails !== undefined) continue;
      const body = (result.result?.value ?? "").trim();
      if (body === "") continue;
      if (frame.suffix === "") {
        parts.push(body);
      } else {
        // Refs are numbered per frame, so e1 in a frame is a different element from e1 in
        // the page. The suffix is what makes a ref mean one thing.
        const qualified = body.replace(/\[ref=(e\d+)\]/g, `[ref=$1${frame.suffix}]`);
        parts.push(`\nFrame ${frame.suffix.slice(1)} (${frame.url}):\n${qualified}`);
      }
    }
    const info = (await this.session.send("Runtime.evaluate", {
      expression: "JSON.stringify({url: location.href, title: document.title})",
      returnByValue: true,
    })) as { result?: { value?: string } };
    const parsed = JSON.parse(info.result?.value ?? '{"url":"","title":""}') as {
      url: string;
      title: string;
    };
    return { text: parts.join("\n") || "(the page has nothing to act on)", ...parsed };
  }

  /** Turns a ref back into a live element handle, in whichever frame owns it. */
  private async resolve(ref: string): Promise<string> {
    const match = /^(e\d+)(@f\d+)?$/.exec(ref.trim());
    if (match === null) {
      throw new CdpError(`"${ref}" is not a ref. Refs look like e4, or e4@f1 inside a frame.`);
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

  async click(ref: string): Promise<void> {
    const objectId = await this.resolve(ref);
    const { x, y } = await this.centreOf(objectId);
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

  async hover(ref: string): Promise<void> {
    const objectId = await this.resolve(ref);
    const { x, y } = await this.centreOf(objectId);
    await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  }

  async type(ref: string, text: string, replace: boolean): Promise<void> {
    const objectId = await this.resolve(ref);
    await this.session.send("DOM.focus", { objectId }).catch(async () => {
      // Not everything focusable through a click is focusable through DOM.focus.
      await this.click(ref);
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

  async read(): Promise<string> {
    const result = (await this.session.send("Runtime.evaluate", {
      expression: READ_SCRIPT,
      returnByValue: true,
    })) as { result?: { value?: string } };
    return result.result?.value ?? "";
  }

  /** Everything an action returns: what happened, then what the page looks like now. */
  async report(expectNavigation = false): Promise<BrowserResult> {
    await this.settle(expectNavigation);
    const { text, url, title } = await this.snapshot();
    const dialog = this.lastDialog;
    this.lastDialog = undefined;
    return { url, title, snapshot: text, ...(dialog !== undefined ? { dialog } : {}) };
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
    if (existing !== undefined) this.pages.delete(display);

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
    return page;
  }

  async open(display: number, url: string): Promise<BrowserResult> {
    const page = await this.pageFor(display, url);
    await page.navigate(url);
    return page.report(true);
  }

  async snapshot(display: number): Promise<BrowserResult> {
    const page = await this.pageFor(display);
    return page.report();
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
    options: { ref?: string; text?: string; key?: string; replace?: boolean }
  ): Promise<BrowserResult> {
    const page = await this.pageFor(display);
    const needsRef = action === "click" || action === "type" || action === "hover";
    if (needsRef && (options.ref === undefined || options.ref === "")) {
      throw new CdpError(`${action} needs the ref of the thing to act on, from a snapshot.`);
    }
    switch (action) {
      case "click":
        await page.click(options.ref!);
        break;
      case "hover":
        await page.hover(options.ref!);
        break;
      case "type":
        await page.type(options.ref!, options.text ?? "", options.replace !== false);
        break;
      case "key":
        await page.press(options.key ?? "Enter");
        break;
      default:
        throw new CdpError(`${action} is not something this does: click, type, key or hover.`);
    }
    return page.report();
  }

  async scroll(display: number, direction: string, amount: number): Promise<BrowserResult> {
    const page = await this.pageFor(display);
    await page.scroll(direction, amount);
    return page.report();
  }

  async upload(display: number, ref: string, files: string[]): Promise<BrowserResult> {
    const page = await this.pageFor(display);
    await page.upload(ref, files);
    return page.report();
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
