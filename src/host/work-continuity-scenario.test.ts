/**
 * A person's conversation with an agent is one thread (INV-1822).
 *
 * Each request is its own piece of work — its own plan, its own todo list, its own card when it is
 * not settled at once — but the second request is said to somebody who heard the first. An agent
 * that read a file and is then asked "what was in it" must not have to read it again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { runEpisode } from "./scenario.ts";
import { TaskStore } from "./tasks.ts";
import { answeredInChat } from "./task-audience.ts";

const CODE = "ZEBRA-4271";
const BACKGROUND = "BACKGROUND-NOTE-9913";

const contextText = (messages: Anthropic.MessageParam[]): string => JSON.stringify(messages);

/** What the person last said, as the model sees it: the thread opens with the first request, not this one. */
function asked(messages: Anthropic.MessageParam[]): string {
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    const text = message.content.find(block => block.type === "text");
    if (text?.type === "text") return text.text;
  }
  return "";
}

test("a second request sees what the first one read, and not what a background turn said in between", async () => {
  const tasks = new TaskStore(null);
  const contexts: { opened: string; text: string; system: string }[] = [];
  const episode = await runEpisode({
    team: [{ name: "Mia", tools: ["read_file", "SetTodos"] }],
    tasks,
    says: [],
    files: { "/home/box/work/a.txt": `The warehouse code is ${CODE}.` },
    script: context => {
      contexts.push({ opened: asked(context.messages), text: contextText(context.messages), system: context.system });
      const request = asked(context.messages);
      const mine = contexts.filter(row => row.opened === request).length;
      if (request.includes("confirm you have read it")) {
        if (mine === 1) return { call: "read_file", input: { path: "/home/box/work/a.txt" } };
        if (mine === 2) return { call: "SetTodos", input: { todos: [{ text: "Read the file", status: "done" }] } };
        return { say: "I have read the file." };
      }
      return { say: "Answered." };
    },
    drive: async ({ bus, frontId, say }) => {
      await say("Read /home/box/work/a.txt and confirm you have read it.");
      bus.sendFromUser(frontId, `Routine digest: ${BACKGROUND}`, { synthetic: true, origin: "host:routine", lane: "background" });
      await bus.wake(frontId);
      await bus.idle();
      await say("Now tell me the warehouse code from that file.");
    },
  });
  try {
    const second = contexts.find(row => row.opened.includes("Now tell me"));
    assert.ok(second, "the second request reached the model");
    assert.ok(second.text.includes(CODE), "the file the first request read is still in the context");
    assert.ok(second.text.includes("I have read the file."), "and so is the first answer");
    assert.ok(!second.text.includes(BACKGROUND), "a background turn's words are not part of the person's thread");
    assert.ok(!second.system.includes("Read the file"), "the first request's todo list is not the second request's");
  } finally {
    episode.cleanup();
  }
});

test("a request answered in one turn leaves no card on the person's list; one still waiting stays", async () => {
  const tasks = new TaskStore(null);
  let planned = false;
  const episode = await runEpisode({
    team: [{ name: "Mia", tools: ["SetTodos"] }],
    tasks,
    says: [],
    script: context => {
      if (asked(context.messages).includes("Plan the offsite") && !planned) {
        planned = true;
        return { call: "SetTodos", input: { todos: [{ text: "Book the venue", status: "pending" }] } };
      }
      return { say: "Here you are." };
    },
    drive: async ({ say }) => {
      await say("What is the capital of France?");
      await say("Plan the offsite and book the venue.");
    },
  });
  try {
    const [asked, offsite] = ["What is the capital", "Plan the offsite"].map(start => tasks.list().find(task => task.title.startsWith(start)));
    assert.ok(asked && offsite, "both requests were recorded");
    assert.equal(asked.status, "done", "the answered question is closed");
    assert.equal(answeredInChat(asked), true, "and is a chat exchange, not a card");
    assert.notEqual(offsite.status, "done", "the request with an unfinished plan is still open");
    assert.equal(answeredInChat(offsite), false);
  } finally {
    episode.cleanup();
  }
});
