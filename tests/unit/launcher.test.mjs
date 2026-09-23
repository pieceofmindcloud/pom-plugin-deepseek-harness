import assert from "node:assert/strict";
import { test } from "node:test";
import { bootPlan, defaultModelChange, forwardedPath, mountPrefix, pomPatch, rewriteScript } from "../../runtime/launcher.mjs";

test("the forwarded target keeps every byte of the query", () => {
  assert.equal(forwardedPath("/plugins/??@a/b.js,@c/d.js&rev=1"), "/plugins/??@a/b.js,@c/d.js&rev=1");
  assert.equal(forwardedPath("/"), "/");
});

test("only a plugin proxy route is accepted as the mount prefix", () => {
  assert.equal(mountPrefix("/api/ui/plugins/deepseek_harness/proxy"), "/api/ui/plugins/deepseek_harness/proxy");
  assert.equal(mountPrefix("/api/ui/plugins/deepseek_harness/proxy/extra"), "");
  assert.equal(mountPrefix("https://evil.example/"), "");
  assert.equal(mountPrefix(undefined), "");
});

test("the boot plan points every harness URL under the mount prefix", () => {
  const html = [
    '<base href="/">',
    '<script>globalThis["__DSH_BOOT__"] = {"entries":[{"url":"/plugins/??@x/client.js&rev=1"}]}</script>',
    '<script src="/plugins/??@deepseek-ai/dsh-client-modules/client.js&amp;rev=2"></script>',
    '<script type="module" crossorigin src="./assets/index-A.js"></script>',
    '<link rel="stylesheet" crossorigin href="./assets/index-B.css">',
    '<link rel="modulepreload" crossorigin href="./assets/vendor-C.js">',
  ].join("\n");
  const plan = bootPlan(html, "/api/ui/plugins/demo/proxy");
  assert.deepEqual(plan.styles, ["/api/ui/plugins/demo/proxy/assets/index-B.css"]);
  assert.deepEqual(
    plan.steps.map((step) => step.kind),
    ["inline", "script", "module"],
  );
  assert.match(plan.steps[0].code, /"url":"\/api\/ui\/plugins\/demo\/proxy\/plugins\/\?\?@x\/client\.js&rev=1"/);
  assert.equal(plan.steps[1].url, "/api/ui/plugins/demo/proxy/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=2");
  assert.equal(plan.steps[2].url, "/api/ui/plugins/demo/proxy/assets/index-A.js");
});

test("harness bundles resolve their origin and mount point through the plugin", () => {
  const source = [
    'const root = document.getElementById("root");',
    "const origin = globalThis.location?.origin;",
    "const location = globalThis.location;",
    "const here = window.location.origin;",
    "const source = new EventSource(EVENTS_ENDPOINT);",
    "isLoopback: isLoopbackHostname(pageLocation.hostname),",
  ].join("\n");
  const rewritten = rewriteScript(source);
  assert.match(rewritten, /getElementById\("dsh-root"\)/);
  assert.match(rewritten, /\(globalThis\.__DSH_POM__\?\.origin \?\? globalThis\.location\?\.origin\)/);
  assert.match(rewritten, /const location = globalThis\.__DSH_POM__ \?\? globalThis\.location;/);
  assert.match(rewritten, /\(globalThis\.__DSH_POM__\?\.origin \?\? window\.location\.origin\)/);
  assert.match(rewritten, /new EventSource\(new URL\(EVENTS_ENDPOINT, globalThis\.__DSH_POM__ \?\? location\.href\)\)/);
  assert.match(rewritten, /isLoopback: \(globalThis\.__DSH_POM__ !== void 0 \|\| isLoopbackHostname\(pageLocation\.hostname\)\),/);
});

test("the live patch carries only the POM route", () => {
  assert.deepEqual(pomPatch([], "http://127.0.0.1:8080/v1"), []);
  const patch = pomPatch([{ id: "a", name: "a" }, { id: "b", name: "b" }], "http://127.0.0.1:8080/v1");
  assert.equal(patch.length, 1, "reloading agent-default-model takes the session controller down");
  assert.deepEqual(patch[0], {
    id: "llm-pi-ai",
    config: {
      providers: {
        pom: {
          displayName: "POM",
          api: "openai-completions",
          baseURL: "http://127.0.0.1:8080/v1",
          apiKeyEnv: "DSH_POM_LLM_API_KEY",
          models: [{ id: "a", name: "a" }, { id: "b", name: "b" }],
        },
      },
    },
  });
});

test("the default model moves to POM without overriding a real choice", () => {
  const base = { provider: "deepseek-official", model: "deepseek-flash" };
  const models = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(defaultModelChange(base, base, models), { provider: "pom", model: "a" });
  assert.equal(defaultModelChange(base, base, []), undefined, "no POM model to point at");
  assert.equal(defaultModelChange({ provider: "pom", model: "b" }, base, models), undefined, "still served");
  assert.deepEqual(defaultModelChange({ provider: "pom", model: "gone" }, base, models), { provider: "pom", model: "a" });
  assert.equal(
    defaultModelChange({ provider: "anthropic", model: "claude" }, base, models),
    undefined,
    "the user picked another provider",
  );
});
