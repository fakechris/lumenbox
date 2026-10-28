/** Settings → Decision model (INV-1412): what a save may write, and what the page is told. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { JEV_SETTINGS_JS, jevSettings, jevSettingsChange } from "./jev-settings.ts";

test("a save writes each point's variable, clears it for off, and refuses unknown points and modes a point does not take", () => {
  assert.deepEqual(jevSettingsChange({ points: { memory_judge: "on", answer_review: "off" } }), {
    env: { AGENTBOX_JEV_MEMORY_JUDGE: "on", AGENTBOX_JEV_ANSWER_REVIEW: null },
  });
  assert.match(String((jevSettingsChange({ points: { auto_review: "on" } }) as { error: string }).error), /auto_review takes off, shadow/);
  assert.match(String((jevSettingsChange({ points: { everything: "on" } }) as { error: string }).error), /Unknown judgement point/);
  assert.deepEqual(jevSettingsChange({ key: "  ts_abc  " }), { env: { TYPESAFE_TOKEN: "ts_abc" } });
});

test("the page is told whether a key exists and each point's mode, never the key", () => {
  const saved = { token: process.env.TYPESAFE_TOKEN, key: process.env.TYPESAFE_API_KEY, judge: process.env.AGENTBOX_JEV_MEMORY_JUDGE, review: process.env.AGENTBOX_JEV_AUTO_REVIEW };
  try {
    process.env.TYPESAFE_TOKEN = "ts_secret_value";
    process.env.AGENTBOX_JEV_MEMORY_JUDGE = "shadow";
    process.env.AGENTBOX_JEV_AUTO_REVIEW = "on";
    const settings = jevSettings();
    assert.equal(settings.keyPresent, true);
    assert.ok(!JSON.stringify(settings).includes("ts_secret_value"));
    assert.equal(settings.points.find(p => p.point === "memory_judge")?.mode, "shadow");
    assert.equal(settings.points.find(p => p.point === "auto_review")?.mode, "off", "a mode the point does not take reads as off");
  } finally {
    for (const [name, value] of [["TYPESAFE_TOKEN", saved.token], ["TYPESAFE_API_KEY", saved.key], ["AGENTBOX_JEV_MEMORY_JUDGE", saved.judge], ["AGENTBOX_JEV_AUTO_REVIEW", saved.review]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.ok(!JEV_SETTINGS_JS.includes("${"), "the script ships as written");
});
