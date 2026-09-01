/**
 * One stand-in for the model client, for every test that needs one.
 *
 * `turn.test.ts` grew a canonical stub and twelve variants beside it, each re-deriving
 * the same three-part shape — `messages.stream(params)` returning something with `on()`
 * and `finalMessage()`. That is thirteen separate beliefs about what the turn loop calls,
 * and the failure mode is quiet: change the loop to use a fourth method and twelve stubs
 * are updated while the thirteenth keeps passing against a call that no longer happens.
 *
 * So the shape is written once, here, and what varies — which reply, when to throw, what
 * to record — is a function the caller supplies. Hermes's Python suite is the cautionary
 * case: `_FakeOpenAI` redefined in 72 files, `FakeResponses` seven times in one of them.
 *
 * Not a recording and not a server: the turn loop is what is under test, and it holds a
 * client object. A fake at the HTTP boundary would be the right choice for testing the
 * provider layer — the SSE parser, retries, the wire — and this is deliberately not that.
 */

import type Anthropic from "@anthropic-ai/sdk";

/** Every request the fake was handed, in order. Snapshots, not references. */
export interface ModelCapture {
  params: Anthropic.MessageCreateParams[];
}

export interface FakeCall {
  /** 0 for the first call of the turn, 1 for the next, and so on. */
  index: number;
  params: Anthropic.MessageCreateParams;
}

export interface FakeModelOptions {
  /** Collects the assembled requests, for assertions about the prompt. */
  capture?: ModelCapture;
  /**
   * Whether to replay the reply's text through the `text` event.
   *
   * Off by default because most tests assert on the final message; on where the test is
   * about streaming — the turn loop's progress reporting reads this event.
   */
  streamText?: boolean;
  /**
   * `messages.create`, which is a different method on the same client: the summariser
   * and the memory extractor use it, and a fake that only knows `stream` makes a test
   * about compaction fail in a way that looks like the compaction being broken.
   */
  create?: (call: FakeCall) => Anthropic.Message | Promise<Anthropic.Message>;
  /**
   * Raw stream events for a call, replayed through the `streamEvent` listener. The turn
   * loop reads these to tell an opened-but-silent stream from one making progress, so a
   * test about that distinction has to be able to send them.
   */
  events?: (call: FakeCall) => readonly unknown[];
}

/**
 * A client whose every call is answered by `respond`.
 *
 * Throwing from `respond` is how a test makes the model fail: the throw surfaces from
 * `finalMessage()`, which is where the turn loop meets a real provider error.
 */
export function fakeModel(
  respond: (call: FakeCall) => Anthropic.Message | Promise<Anthropic.Message>,
  options: FakeModelOptions = {}
): Anthropic {
  let index = 0;
  let created = 0;
  return {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        if (options.create === undefined) {
          throw new Error(
            "This fake model has no `create` responder, and something called it. Pass " +
              "`create` if the code under test summarises or extracts."
          );
        }
        return options.create({ index: created++, params });
      },
      stream(params: Anthropic.MessageCreateParams) {
        // The messages array is snapshotted because the turn loop keeps appending to
        // the same array across rounds — holding the reference made every captured
        // request look identical to the last one.
        options.capture?.params.push({ ...params, messages: [...params.messages] });
        const call = { index: index++, params };
        // Answered once per call, however many times the turn loop asks. A `respond`
        // that stops a policy gate or counts rounds has side effects, and calling it
        // again for the text stream would fire them twice — the kind of fake that
        // makes a test prove something the code never did.
        let answer: Anthropic.Message | Promise<Anthropic.Message> | undefined;
        let refusal: unknown;
        const settle = () => {
          if (answer === undefined && refusal === undefined) {
            try {
              answer = respond(call);
            } catch (error) {
              refusal = error;
            }
          }
        };
        return {
          // The listener is typed loosely because the two events this fake emits carry
          // different payloads — a text delta and a raw stream event — and the SDK's own
          // overloads are what the turn loop sees, not this.
          on(event: string, handler: (payload: never) => void) {
            if (event === "streamEvent" && options.events !== undefined) {
              for (const raw of options.events(call)) handler(raw as never);
            }
            if (options.streamText === true && event === "text") {
              settle();
              // Replayed synchronously when the answer is already a message, because
              // that is the order a real stream delivers in: text before the final.
              if (answer !== undefined && !(answer instanceof Promise)) {
                for (const block of answer.content) {
                  if (block.type === "text") handler(block.text as never);
                }
              }
            }
            return this;
          },
          finalMessage: async () => {
            settle();
            if (refusal !== undefined) throw refusal;
            return answer as Anthropic.Message | Promise<Anthropic.Message>;
          },
        };
      },
    },
  } as unknown as Anthropic;
}

/**
 * The common case: a fixed list of replies, the last one repeating.
 *
 * Repeating rather than running out, because a turn's round count is a property of the
 * conversation and a test that pins it is usually pinning something it did not mean to.
 */
export function fakeModelReplying(
  replies: readonly Anthropic.Message[],
  options: FakeModelOptions = {}
): Anthropic {
  return fakeModel(({ index }) => replies[Math.min(index, replies.length - 1)]!, options);
}
