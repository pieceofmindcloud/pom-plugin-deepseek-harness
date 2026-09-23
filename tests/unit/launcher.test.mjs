import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardedPath, rewriteScript } from "../../runtime/launcher.mjs";

test("the key parameter is removed without re-encoding the rest of the query", () => {
  assert.equal(forwardedPath("/plugins/??@a/b.js,@c/d.js&rev=1"), "/plugins/??@a/b.js,@c/d.js&rev=1");
  assert.equal(forwardedPath("/api/remote.mux?a=1&dsh_pom_key=k&b=2"), "/api/remote.mux?a=1&b=2");
  assert.equal(forwardedPath("/api/x?dsh_pom_key=k"), "/api/x");
  assert.equal(forwardedPath("/"), "/");
});

test("harness bundles resolve their origin and mount point through the plugin", () => {
  const source = [
    'const root = document.getElementById("root");',
    "const origin = globalThis.location?.origin;",
    "const location = globalThis.location;",
    "const here = window.location.origin;",
    "const source = new EventSource(EVENTS_ENDPOINT);",
  ].join("\n");
  const rewritten = rewriteScript(source);
  assert.match(rewritten, /getElementById\("dsh-root"\)/);
  assert.match(rewritten, /\(globalThis\.__DSH_POM__\?\.origin \?\? globalThis\.location\?\.origin\)/);
  assert.match(rewritten, /const location = globalThis\.__DSH_POM__ \?\? globalThis\.location;/);
  assert.match(rewritten, /\(globalThis\.__DSH_POM__\?\.origin \?\? window\.location\.origin\)/);
  assert.match(rewritten, /new EventSource\(new URL\(EVENTS_ENDPOINT, globalThis\.__DSH_POM__ \?\? location\.href\)\)/);
});
