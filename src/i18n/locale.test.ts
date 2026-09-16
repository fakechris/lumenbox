/**
 * Choosing a language (INV-544): what somebody set beats what their browser asks for,
 * which beats what the door implies, which beats the installation's default.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LOCALE, localeFromAcceptLanguage, localeOfChannel, resolveLocale } from "./locale.ts";

test("the order is how much somebody meant it", () => {
  assert.equal(resolveLocale({ preference: "en", acceptLanguage: "zh-CN", channelType: "feishu" }), "en", "a decision beats a guess");
  assert.equal(resolveLocale({ acceptLanguage: "en-GB,en;q=0.9", channelType: "feishu" }), "en", "a browser's ask beats a door's implication");
  assert.equal(resolveLocale({ channelType: "feishu" }), "zh");
  assert.equal(resolveLocale({ channelType: "telegram" }), "en");
  assert.equal(resolveLocale({ installationDefault: "en" }), "en");
  assert.equal(resolveLocale({}), DEFAULT_LOCALE, "and the fallback is what every chat string here already was");
  assert.equal(resolveLocale({ preference: "fr" }), DEFAULT_LOCALE, "a language we do not have is not a preference we can honour");
});

test("Accept-Language is read by weight, and only for languages we have", () => {
  assert.equal(localeFromAcceptLanguage("zh-CN,zh;q=0.9,en;q=0.8"), "zh");
  assert.equal(localeFromAcceptLanguage("en-US,en;q=0.9,zh;q=0.8"), "en");
  assert.equal(localeFromAcceptLanguage("fr-FR,fr;q=0.9,zh;q=0.5"), "zh", "the best one we actually have");
  assert.equal(localeFromAcceptLanguage("fr,de"), undefined);
  assert.equal(localeFromAcceptLanguage(""), undefined);
  assert.equal(localeFromAcceptLanguage(undefined), undefined);
  // Weight decides, not order in the string.
  assert.equal(localeFromAcceptLanguage("zh;q=0.2,en;q=0.9"), "en");
});

test("a door implies a room, and says nothing about a person", () => {
  assert.equal(localeOfChannel("feishu"), "zh");
  assert.equal(localeOfChannel("dingtalk"), "zh");
  assert.equal(localeOfChannel("telegram"), "en");
  assert.equal(localeOfChannel("something-new"), undefined);
  assert.equal(localeOfChannel(undefined), undefined);
});
