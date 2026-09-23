import assert from "node:assert/strict";
import { test } from "node:test";
import { rebaseUrls, scopeSelector, scopeSelectorList, splitSelectorList } from "../../ui/src/harness/scopeCss.ts";

const scope = "#dsh-root";

test("document-root selectors become the harness container", () => {
  assert.equal(scopeSelector(":root", scope), "#dsh-root");
  assert.equal(scopeSelector("html", scope), "#dsh-root");
  assert.equal(scopeSelector("html body", scope), "#dsh-root");
  assert.equal(scopeSelector("body > .app", scope), "#dsh-root .app");
  assert.equal(scopeSelector("#root", scope), "#dsh-root");
  assert.equal(scopeSelector("#root .shell", scope), "#dsh-root .shell");
});

test("attribute-qualified roots stay on the real document above the container", () => {
  assert.equal(scopeSelector("body[data-ds-dark-theme] .card", scope), "body[data-ds-dark-theme] #dsh-root .card");
  assert.equal(scopeSelector(':root[data-palette="dim"]', scope), ':root[data-palette="dim"] #dsh-root');
});

test("everything else is nested under the container", () => {
  assert.equal(scopeSelector(".button:hover", scope), "#dsh-root .button:hover");
  assert.equal(scopeSelector("*", scope), "#dsh-root *");
  assert.equal(scopeSelector("bodyish", scope), "#dsh-root bodyish");
});

test("selector lists split only on top-level commas", () => {
  assert.deepEqual(splitSelectorList(".a, :is(.b, .c) .d, [x=\",\"]"), [".a", ":is(.b, .c) .d", "[x=\",\"]"]);
  assert.equal(scopeSelectorList("html, .a", scope), "#dsh-root, #dsh-root .a");
});

test("relative urls resolve against the harness origin", () => {
  const base = "http://node:4100/assets/app.css";
  assert.equal(rebaseUrls("src:url(./fonts/a.woff2)", base), 'src:url("http://node:4100/assets/fonts/a.woff2")');
  assert.equal(rebaseUrls('url("/favicon.svg")', base), 'url("http://node:4100/favicon.svg")');
  assert.equal(rebaseUrls("url(data:image/png;base64,AA)", base), "url(data:image/png;base64,AA)");
});
