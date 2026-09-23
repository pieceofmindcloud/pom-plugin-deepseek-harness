import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__POM_PLUGIN_CODE__ = "deepseek_harness";
const { toProxyUrl, PROXY_PREFIX } = await import("../../ui/src/harness/mount.ts");

const page = { origin: "https://salem:8080", href: "https://salem:8080/admin-ui/deepseek_harness/harness", protocol: "https:", host: "salem:8080" };

test("harness URLs land on the POM proxy route of the same origin", () => {
  assert.equal(PROXY_PREFIX, "/api/ui/plugins/deepseek_harness/proxy");
  assert.equal(
    toProxyUrl("http://dsh-harness.invalid/api/session.export?sessionId=1", page),
    "https://salem:8080/api/ui/plugins/deepseek_harness/proxy/api/session.export?sessionId=1",
  );
  assert.equal(
    toProxyUrl(new URL("ws://dsh-harness.invalid/api/remote.mux"), page),
    "wss://salem:8080/api/ui/plugins/deepseek_harness/proxy/api/remote.mux",
  );
  assert.equal(
    toProxyUrl("api/workspace/create", page),
    "https://salem:8080/api/ui/plugins/deepseek_harness/proxy/api/workspace/create",
  );
});

test("the POM's own requests are untouched", () => {
  assert.equal(toProxyUrl("/api/ui/node", page), "/api/ui/node");
  assert.equal(toProxyUrl("https://example.com/x", page), "https://example.com/x");
  assert.equal(
    toProxyUrl("/api/ui/plugins/deepseek_harness/proxy/__pom/boot", page),
    "/api/ui/plugins/deepseek_harness/proxy/__pom/boot",
  );
});
