import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compareVersions, ensureDsh, installedVersions, resolveDshVersion } from "../../runtime/dsh-install.mjs";

const quiet = () => {};

function fakeInstall(installed) {
  return async ({ directory, version }) => {
    mkdirSync(join(directory, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
    installed.push(version);
  };
}

function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "dsh-install-"));
  return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

function complete(root, version) {
  mkdirSync(join(root, version), { recursive: true });
  writeFileSync(join(root, version, ".complete"), "x");
}

test("semver order puts a prerelease before its release", () => {
  const sorted = ["0.1.7-rc.2", "0.1.5-rc.3", "0.2.0-rc.1", "0.1.7", "0.1.7-rc.10", "0.1.7-alpha.2"].sort(compareVersions);
  assert.deepEqual(sorted, ["0.1.5-rc.3", "0.1.7-alpha.2", "0.1.7-rc.2", "0.1.7-rc.10", "0.1.7", "0.2.0-rc.1"]);
});

test("a dist-tag resolves through the registry and an exact version does not", async () => {
  let asked = "";
  const fetchImpl = async (url) => {
    asked = url;
    return { ok: true, json: async () => ({ "dist-tags": { latest: "0.1.7-rc.2" } }) };
  };
  assert.equal(await resolveDshVersion("latest", { fetchImpl }), "0.1.7-rc.2");
  assert.equal(asked, "https://registry.npmjs.org/@deepseek-ai%2Fdsh");
  assert.equal(await resolveDshVersion("0.1.5-rc.3", { fetchImpl: () => assert.fail("no lookup") }), "0.1.5-rc.3");
  await assert.rejects(resolveDshVersion("missing", { fetchImpl }), /no dist-tag "missing"/);
});

test("the first start installs the resolved version and marks it complete", () =>
  withRoot(async (root) => {
    const installed = [];
    const dsh = await ensureDsh({ root, track: "latest", log: quiet, resolve: async () => "0.1.7-rc.2", install: fakeInstall(installed) });
    assert.deepEqual(installed, ["0.1.7-rc.2"]);
    assert.equal(dsh.version, "0.1.7-rc.2");
    assert.ok(dsh.bin.endsWith(join("0.1.7-rc.2", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")));
    assert.deepEqual(installedVersions(root), ["0.1.7-rc.2"]);
  }));

test("a newer tagged version replaces the installed one; the same version is not reinstalled", () =>
  withRoot(async (root) => {
    complete(root, "0.1.5-rc.3");
    const installed = [];
    await ensureDsh({ root, track: "latest", log: quiet, resolve: async () => "0.1.5-rc.3", install: fakeInstall(installed) });
    assert.deepEqual(installed, []);
    const dsh = await ensureDsh({ root, track: "latest", log: quiet, resolve: async () => "0.2.0", install: fakeInstall(installed) });
    assert.equal(dsh.version, "0.2.0");
    assert.deepEqual(readdirSync(root), ["0.2.0"]);
  }));

test("offline or a failed install keeps the installed version; nothing installed is an error", () =>
  withRoot(async (root) => {
    const offline = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
    await assert.rejects(ensureDsh({ root, track: "latest", log: quiet, resolve: offline }), /cannot install @deepseek-ai\/dsh@latest/);

    complete(root, "0.1.7-rc.2");
    assert.equal((await ensureDsh({ root, track: "latest", log: quiet, resolve: offline })).version, "0.1.7-rc.2");

    const broken = async () => { throw new Error("npm install failed"); };
    const dsh = await ensureDsh({ root, track: "latest", log: quiet, resolve: async () => "0.2.0", install: broken });
    assert.equal(dsh.version, "0.1.7-rc.2");
    assert.equal(existsSync(join(root, "0.2.0")), false);
  }));

test("an interrupted install without its marker is redone", () =>
  withRoot(async (root) => {
    mkdirSync(join(root, "0.2.0"), { recursive: true });
    const installed = [];
    await ensureDsh({ root, track: "latest", log: quiet, resolve: async () => "0.2.0", install: fakeInstall(installed) });
    assert.deepEqual(installed, ["0.2.0"]);
  }));
