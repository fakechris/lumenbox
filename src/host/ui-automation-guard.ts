/**
 * Keeping the shell out of the browser and off the screen.
 *
 * The desktop and browser tools are where an agent's input goes through the things that
 * watch it: the policy gate sees a click before it happens, an approval card names the
 * button, the transcript records what was typed. A shell command that drives the same
 * browser through its debugging port, or the same screen through xdotool, arrives at the
 * identical outcome having passed none of them. Without this, every one of those controls
 * is a suggestion rather than a boundary.
 *
 * It became necessary the moment box-chrome started opening a debugging port. That port
 * has no authentication of its own — anyone who can reach it owns the browser — and
 * everything in the box can reach it. Keeping it on the box's loopback stops the host and
 * the network from reaching it; this stops the agent from reaching around its own tools.
 *
 * A regex over a command line is not a sandbox, and is not claimed to be one: an agent
 * determined to evade it can, and a person with a shell always could. What it does is
 * make the boundary real for an agent that is not trying to evade anything, which is the
 * case that actually happens — a model reaching for `curl` against port 9222 because that
 * is what it has seen in training, not because it is working around a rule. It is told
 * which tool to use instead, which is the part that changes behaviour.
 */

/**
 * Driving the screen directly, rather than through the desktop tool.
 *
 * ImageMagick's `import` takes screenshots and belongs here on the merits, and is left
 * out anyway: it is also the first word of most Python and JavaScript, so listing it
 * refuses `grep -rn import src/`. Taking a picture is the least harmful thing on this
 * list — it cannot click anything — and boxd already gates a shell by desktop ownership.
 */
const UI_AUTOMATION =
  /\b(xdotool|wmctrl|xte|ydotool|xautomation|scrot|osascript|cliclick|pyautogui|pynput|robotjs)\b/i;

/**
 * Driving the browser directly, rather than through the browser tools.
 *
 * The debugging port by number as well as by flag, because reaching an already-open port
 * is easier than starting a second browser and is the more likely attempt.
 */
const BROWSER_CONTROL = new RegExp(
  [
    // Starting a browser that can be driven, or reaching one that already is.
    String.raw`--remote-debugging-(?:port|pipe)\b`,
    String.raw`(?:127\.0\.0\.1|localhost|\[::1\]):922\d\b`,
    String.raw`/json/(?:new|list|version|close)\b`,
    String.raw`\bchrome-devtools-protocol\b`,
    // The driver libraries, but only where they are being *run* or *loaded*. Matching the
    // bare word refuses `git commit -m "add playwright-style retries"` and
    // `cat notes/chromedriver-alternatives.md`, and an agent believes a refusal that
    // specific — so it stops, on work that was never near a browser.
    String.raw`(?:^|[;|&(]\s*|\bnpx\s+|\bnpm\s+exec\s+|\byarn\s+|\bpnpm\s+(?:dlx\s+)?)(?:puppeteer|playwright|chromedriver|selenium-server)\b`,
    String.raw`\b(?:import|require)\s*\(?\s*["']?(?:puppeteer|playwright|selenium)\b`,
  ].join("|"),
  "i"
);

export interface GuardVerdict {
  /** Absent when the command is fine. */
  refusal?: string;
}

/**
 * Whether a shell command is reaching around the tools, and what to say if it is.
 *
 * The message names the tool that does the same job, because a refusal that only says no
 * gets retried with a different spelling — which is both a wasted turn and the behaviour
 * this exists to prevent.
 */
export function guardShellCommand(command: string): GuardVerdict {
  if (BROWSER_CONTROL.test(command)) {
    return {
      refusal:
        "That command drives the browser directly, which is not how you use it here. " +
        "The browser tools — browser_open, browser_snapshot, browser_act — do the same " +
        "job, give you the page as an outline instead of raw protocol, and are what the " +
        "approval rules and the transcript are attached to. Use those. If you need a page " +
        "as text and nothing else, WebFetch is cheaper than either.",
    };
  }
  if (UI_AUTOMATION.test(command)) {
    return {
      refusal:
        "That command drives the screen directly, which is not how you use it here. The " +
        "`computer` tool moves the mouse, types, presses keys and takes screenshots, and " +
        "it is bound to your own desktop — a shell doing the same thing can land on " +
        "someone else's. Use `computer`.",
    };
  }
  return {};
}
