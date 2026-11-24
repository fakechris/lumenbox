/**
 * Acceptance stories (docs/103) that no other test walks end to end, on the scripted model and the
 * memory box. Each test is named after its story; the story says what a person did and saw.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { BoxError } from "../box/client.ts";
import { runEpisode } from "./scenario.ts";

test("A3: a person takes over the screen mid-task; the box refuses the agent's click and the agent says who is driving", async () => {
  let seen = "";
  const episode = await runEpisode({
    team: [{ name: "Nova" }], says: ["在表单里点保存"], display: 1,
    box: {
      computer: async actions => {
        assert.ok(actions.some(action => action.action === "click"));
        throw new BoxError("USER_IN_CONTROL: a person has taken over desktop 1", 423);
      },
    },
    script: ({ round, messages }) => {
      if (round === 0) return { call: "computer", input: { actions: [{ action: "click", coordinate: [40, 30] }] } };
      seen = JSON.stringify(messages);
      return { say: "你正在操作屏幕，我先停下；交回给我后我再点保存。" };
    },
  });
  try {
    assert.match(seen, /Outcome: refused — USER_IN_CONTROL/, "the agent is told plainly that the person holds the screen");
    assert.equal(episode.score.turns, 1);
    assert.match(episode.score.said.at(-1)?.text ?? "", /你正在操作屏幕/, "and the person hears that the agent is waiting for them");
  } finally { episode.cleanup(); }
});
