/**
 * The box's clipboard, readable and writable from outside it.
 *
 * The desktop is watched through a VNC canvas, and a canvas is not a text field: a URL,
 * a token or a snippet cannot be typed into it without retyping it by hand, and anything
 * an agent leaves on the clipboard inside the box is trapped there. Both directions go
 * through here instead.
 *
 * X has no clipboard daemon of its own — a selection belongs to the process that set it,
 * and disappears when that process exits. So writing means starting an owner and leaving
 * it running: xclip forks into the background and serves the selection until something
 * else claims it, at which point it exits on its own. That is also why reading can
 * legitimately come back empty, if whatever owned the selection has since closed.
 *
 * autocutsel keeps PRIMARY and CLIPBOARD in step, so writing one is enough — see
 * start-display. Verified: killing the owner does lose the content, which is why the
 * owner is deliberately left alive rather than waited on.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Enough for a page of text or a token; not enough to be used as a file transfer. */
export const MAX_CLIPBOARD_BYTES = 1024 * 1024;

const READ_TIMEOUT_MS = 5000;

export class ClipboardError extends Error {}

function displayEnv(display: number): NodeJS.ProcessEnv {
  return { ...process.env, DISPLAY: `:${display}` };
}

/** The CLIPBOARD selection — what Ctrl-V pastes — as text. Empty if nothing owns it. */
export async function readClipboard(display: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "xclip",
      ["-selection", "clipboard", "-o"],
      { env: displayEnv(display), timeout: READ_TIMEOUT_MS, maxBuffer: MAX_CLIPBOARD_BYTES }
    );
    return stdout;
  } catch (error) {
    // "target STRING not available" is what an unowned selection looks like, and an
    // empty clipboard is an answer rather than a failure.
    const message = error instanceof Error ? error.message : String(error);
    if (/not available|Error: target/.test(message)) return "";
    throw new ClipboardError(`Could not read the clipboard: ${message}`);
  }
}

/** How long to wait for the new owner to actually hold the selection. */
const OWNERSHIP_TIMEOUT_MS = 2000;

/**
 * Puts text on the CLIPBOARD selection.
 *
 * Detached on purpose. The owner has to outlive this call — a selection with no live
 * owner is an empty selection — so the process is left running rather than waited on.
 *
 * Then it waits for the selection to actually read back. Handing the text to xclip is not
 * the same as xclip owning the selection, and resolving on the former made a read that
 * followed immediately return empty: a race that only showed up once the box was busy
 * enough for the two to land in the wrong order.
 */
export function writeClipboard(display: number, text: string): Promise<void> {
  if (Buffer.byteLength(text, "utf8") > MAX_CLIPBOARD_BYTES) {
    throw new ClipboardError(
      `Clipboard text is larger than ${MAX_CLIPBOARD_BYTES} bytes; write a file instead.`
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn("xclip", ["-selection", "clipboard"], {
      env: displayEnv(display),
      detached: true,
      stdio: ["pipe", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-500);
    });

    child.on("error", error => reject(new ClipboardError(error.message)));
    // xclip forks and keeps serving; an early exit means it never took the selection.
    child.on("exit", code => {
      if (code !== 0 && code !== null) {
        reject(new ClipboardError(`xclip exited ${code}: ${stderr.trim() || "no output"}`));
      }
    });

    child.stdin.on("error", error => reject(new ClipboardError(error.message)));
    child.stdin.end(text, () => {
      // Let it go: the process is the clipboard now.
      child.unref();
      void confirmOwnership(display, text).then(resolve, reject);
    });
  });
}

/** Polls until the selection reads back what was written, so callers can read next. */
async function confirmOwnership(display: number, expected: string): Promise<void> {
  const deadline = Date.now() + OWNERSHIP_TIMEOUT_MS;
  for (;;) {
    if ((await readClipboard(display)) === expected) return;
    if (Date.now() >= deadline) {
      throw new ClipboardError(
        "The clipboard did not take the new value; nothing may be able to own the " +
          "selection on this display."
      );
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
