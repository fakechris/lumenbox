/** Deadlines follow model content, not keepalives or stream bookkeeping. */
import { FIRST_TOKEN_DEADLINE_MS, STREAM_IDLE_DEADLINE_MS, FirstTokenStallError, StreamIdleStallError } from "./transient.ts";

export function watchModelStream(control: AbortController, outer: AbortSignal, firstMs = FIRST_TOKEN_DEADLINE_MS, idleMs = STREAM_IDLE_DEADLINE_MS) {
  let produced = false;
  let stalled: Error | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = produced ? new StreamIdleStallError(idleMs) : new FirstTokenStallError(firstMs);
      control.abort();
    }, produced ? idleMs : firstMs);
    timer.unref?.();
  };
  const abort = () => control.abort();
  outer.addEventListener("abort", abort, { once: true });
  if (outer.aborted) abort();
  arm();
  const progress = () => { produced = true; arm(); };
  return {
    progress,
    event(event: { type: string; delta?: unknown; content_block?: unknown }) {
      // Empty block starts, usage, signatures and stop events are not generated content.
      const content = event.type === "content_block_delta" ? event.delta : event.type === "content_block_start" ? event.content_block : undefined;
      if (content === null || typeof content !== "object") return;
      const record = content as Record<string, unknown>;
      if (["text", "thinking", "partial_json"].some(key => typeof record[key] === "string" && record[key] !== "")) progress();
      else if (event.type === "content_block_start" && record.type === "tool_use" && typeof record.name === "string" && record.name !== "") progress();
    },
    get produced() { return produced; },
    get failure() { return stalled; },
    release() { clearTimeout(timer); outer.removeEventListener("abort", abort); },
  };
}

/** Cancellation ends a server-paced wait immediately and releases its timer/listener. */
export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
