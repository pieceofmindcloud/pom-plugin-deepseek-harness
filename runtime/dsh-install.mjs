// Installs the official `@deepseek-ai/dsh` release on first use and keeps it
// on the newest version of the npm dist-tag (or exact version) the build
// tracks, instead of bundling it in the plugin library.
//
// Each version lives in `<root>/<version>` and counts only once its
// `.complete` marker is written, so an interrupted install is redone. After a
// newer version installs, older ones are removed. When the npm registry is
// unreachable the newest installed version is used, so an offline node keeps
// working after the first install.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DSH_PACKAGE = "@deepseek-ai/dsh";
const REGISTRY = "https://registry.npmjs.org";
const RESOLVE_TIMEOUT_MS = 20_000;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MARKER = ".complete";

/** Compare two semver strings; a prerelease sorts before its release. */
export function compareVersions(left, right) {
  const parse = (value) => {
    const [core, pre = ""] = value.split("+")[0].split(/-(.*)/s);
    return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null && nx !== ny) return nx - ny;
    if (nx !== null && ny === null) return -1;
    if (nx === null && ny !== null) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Complete installs under `root`, newest first. */
export function installedVersions(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => EXACT_VERSION.test(entry) && existsSync(join(root, entry, MARKER)))
    .sort((left, right) => compareVersions(right, left));
}

/** The exact version a dist-tag or version points to, from the npm registry. */
export async function resolveDshVersion(track, { fetchImpl = fetch, registry = REGISTRY } = {}) {
  if (EXACT_VERSION.test(track)) return track;
  const url = `${registry.replace(/\/+$/, "")}/${DSH_PACKAGE.replace("/", "%2F")}`;
  const response = await fetchImpl(url, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry answered HTTP ${response.status}`);
  const metadata = await response.json();
  const version = metadata?.["dist-tags"]?.[track];
  if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
    throw new Error(`${DSH_PACKAGE} has no dist-tag "${track}"`);
  }
  return version;
}

/** `npm install` the harness into `directory` with the bundled Node and npm. */
export function npmInstall({ directory, version, nodeBin, npmCli, cacheDir, log }) {
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "pom-dsh-runtime", private: true, dependencies: { [DSH_PACKAGE]: version } }, null, 2)}\n`,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      nodeBin,
      [npmCli, "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
      {
        cwd: directory,
        env: {
          ...process.env,
          npm_config_cache: cacheDir,
          npm_config_update_notifier: "false",
          npm_config_fund: "false",
          npm_config_audit: "false",
        },
        // Never the plugin host's stdin/stdout: the launcher reports on stdout.
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install ${DSH_PACKAGE}@${version} failed (${code}): ${stderr.trim()}`));
    });
    log(`installing ${DSH_PACKAGE}@${version} from npm`);
  });
}

/** Drop prebuilt node-pty binaries for other platforms and type declarations. */
function slim(directory, keepPty) {
  const prebuilds = join(directory, "node_modules", "node-pty", "prebuilds");
  if (keepPty && existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds)) {
      if (entry !== keepPty) rmSync(join(prebuilds, entry), { recursive: true, force: true });
    }
  }
}

/**
 * Make sure a harness install is ready and return its CLI entry point.
 * `install` defaults to `npmInstall`; tests pass a stub.
 */
export async function ensureDsh({ root, track, keepPty, log, resolve = resolveDshVersion, install, ...npm }) {
  mkdirSync(root, { recursive: true });
  const installed = installedVersions(root);
  let version;
  try {
    version = await resolve(track);
  } catch (error) {
    if (installed.length === 0) {
      throw new Error(`cannot install ${DSH_PACKAGE}@${track}: ${error.message}`);
    }
    log(`npm registry unavailable (${error.message}); using installed ${DSH_PACKAGE}@${installed[0]}`);
    return entry(root, installed[0]);
  }

  if (!installed.includes(version)) {
    const directory = join(root, version);
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
    try {
      await (install ?? npmInstall)({ directory, version, log, ...npm });
      slim(directory, keepPty);
      writeFileSync(join(directory, MARKER), `${new Date().toISOString()}\n`);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      if (installed.length === 0) throw error;
      log(`${error.message}; keeping ${DSH_PACKAGE}@${installed[0]}`);
      return entry(root, installed[0]);
    }
  }

  for (const other of installedVersions(root)) {
    if (other !== version) rmSync(join(root, other), { recursive: true, force: true });
  }
  return entry(root, version);
}

function entry(root, version) {
  return { version, bin: join(root, version, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js") };
}
