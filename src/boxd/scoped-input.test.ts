import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { SCOPED_INPUT_SCRIPT } from "./browser-service.ts";

function fixture() {
  const writes: string[] = [];
  const events: string[] = [];
  class Field {
    tagName = "INPUT"; type = "email"; isConnected = true;
    ownerDocument = { location: { host: "forms.example", origin: "https://forms.example" } };
    getAttribute(name: string) { return name === "aria-label" ? "Email" : null; }
    get value() { return writes.at(-1) ?? ""; }
    set value(value: string) { writes.push(value); }
    focus() { throw new Error("focus would redirect the keyboard to another field"); }
    dispatchEvent(event: Event) { events.push(event.type); }
  }
  const field = new Field();
  const expected = { field: { tag: "input", type: "email", autocomplete: "", name: "", label: "Email", signIn: false },
    host: "forms.example", origin: "https://forms.example" };
  const apply = runInNewContext(`(${SCOPED_INPUT_SCRIPT})`, { HTMLInputElement: Field, HTMLTextAreaElement: class {}, Event, Date });
  return { field, writes, events, expected, apply };
}

test("scoped typing writes the bound node without a focus or an empty input event that can redirect typing", () => {
  const f = fixture();
  assert.equal(f.apply.call(f.field, "me@example.com", true, f.expected, Date.now() + 1000), "ok");
  assert.deepEqual(f.writes, ["me@example.com"]);
  assert.deepEqual(f.events, ["input", "change"]);
  assert.equal(f.apply.call(f.field, ".extra", false, f.expected, Date.now() + 1000), "ok");
  assert.equal(f.field.value, "me@example.com.extra");
});

test("scoped typing rechecks expiry, field description, origin and node attachment at the atomic write", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.field.ownerDocument.location.origin = "https://other.example"; },
    (f: ReturnType<typeof fixture>) => { f.field.type = "password"; },
    (f: ReturnType<typeof fixture>) => { f.field.isConnected = false; },
  ]) {
    const f = fixture(); mutate(f);
    assert.notEqual(f.apply.call(f.field, "me@example.com", true, f.expected, Date.now() + 1000), "ok");
    assert.deepEqual(f.writes, []); assert.deepEqual(f.events, []);
  }
  for (const expiry of [Date.now(), undefined, Number.NaN]) {
    const f = fixture();
    assert.notEqual(f.apply.call(f.field, "me@example.com", true, f.expected, expiry), "ok");
    assert.deepEqual(f.writes, []);
  }
});
