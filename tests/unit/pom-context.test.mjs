import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessLanguages, pomEventValue, pomLocale, pomTheme, PomColorSchemeQuery } from "../../ui/src/harness/pomContext.ts";

test("the POM theme and locale are read from the shell's <html>", () => {
  assert.equal(pomTheme({ dataset: { theme: "light" } }), "light");
  assert.equal(pomTheme({ dataset: { theme: "dark" } }), "dark");
  assert.equal(pomTheme({ dataset: {} }), "dark");
  assert.equal(pomLocale({ lang: "pt-BR" }), "pt-BR");
  assert.equal(pomLocale({ lang: "" }), "en");
});

test("the harness is offered the POM locale first and English as the fallback", () => {
  assert.deepEqual(harnessLanguages("pt-BR"), ["pt-BR", "pt", "en"]);
  assert.deepEqual(harnessLanguages("en"), ["en"]);
});

test("only pom-plugin-events/v1 envelopes for every plugin or this one are read", () => {
  const event = { protocol: "pom-plugin-events/v1", type: "theme.changed", target: "*", payload: { theme: "light" } };
  assert.deepEqual(pomEventValue(event, "deepseek_harness"), { type: "theme.changed", payload: { theme: "light" } });
  assert.deepEqual(pomEventValue({ ...event, target: "deepseek_harness" }, "deepseek_harness")?.type, "theme.changed");
  assert.equal(pomEventValue({ ...event, target: "other" }, "deepseek_harness"), null);
  assert.equal(pomEventValue({ ...event, protocol: "v0" }, "deepseek_harness"), null);
  assert.equal(pomEventValue(null, "deepseek_harness"), null);
});

test("a color-scheme query answers from the POM theme and notifies every listener style", () => {
  let theme = "dark";
  const query = new PomColorSchemeQuery("(prefers-color-scheme: dark)", "dark", () => theme);
  const seen = [];
  query.addEventListener("change", (event) => seen.push(`event:${event.matches}`));
  query.addListener((event) => seen.push(`legacy:${event.matches}`));
  query.onchange = (event) => seen.push(`onchange:${event.matches}`);
  assert.equal(query.matches, true);

  theme = "light";
  query.notify();
  assert.equal(query.matches, false);
  assert.deepEqual(seen, ["event:false", "onchange:false", "legacy:false"]);
});
