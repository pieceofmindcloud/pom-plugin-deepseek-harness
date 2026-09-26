// Supervisor of the official DeepSeek Harness inside the POM plugin.
//
// The plugin library starts this script with the Node runtime shipped next to
// it, passing the model endpoint and API key the POM handed over
// (`DSH_POM_LLM_BASE_URL`, `DSH_POM_LLM_API_KEY`). It boots the unmodified
// `dsh web` server on a private loopback port, points its pi-ai provider at
// the POM, and fronts it with a loopback proxy that only the POM node reaches:
// the node mounts it at `/api/ui/plugins/<code>/proxy` (admin-only) and adds
// the per-launch token in `x-pom-plugin-token`. The proxy adapts the harness
// to run inside a POM <div>:
//
// - every browser base the harness derives from `location` is redirected to
//   `globalThis.__DSH_POM__`, which the plugin screen maps to the POM route;
// - the harness mount point `#root` becomes `#dsh-root` (the POM owns #root);
// - the harness browser session is established here, server side.
//
// Protocol with the plugin library: exactly one JSON line on stdout once
// ready (`{"status":"ready","port":N,"token":"..."}`) or failed
// (`{"status":"error","error":"..."}`). Logs go to stderr. The process exits
// when stdin closes, so it never outlives the plugin host.

import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const dataDir = env.DSH_POM_DATA_DIR || join(here, "data");
const dshHome = env.DSH_POM_HOME_DIR || join(dataDir, "dsh-home");
const workspace = env.DSH_POM_WORKSPACE || join(dataDir, "workspace");
const llmBaseUrl = (env.DSH_POM_LLM_BASE_URL || "").replace(/\/+$/, "");
const llmApiKey = env.DSH_POM_LLM_API_KEY || "";
const dshBin = join(here, "app", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const TOKEN_HEADER = "x-pom-plugin-token";
const PREFIX_HEADER = "x-forwarded-prefix";
const MOUNT_PREFIX = /^\/api\/ui\/plugins\/[a-z0-9][a-z0-9_.-]*\/proxy$/;
const token = randomBytes(32).toString("base64url");
const MODEL_POLL_MS = Number(env.DSH_POM_MODEL_POLL_MS || 15_000);

let child;
let reported = false;

function log(message) {
  process.stderr.write(`dsh-pom: ${message}\n`);
}

function report(value) {
  if (reported) return;
  reported = true;
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  log(message);
  report({ status: "error", error: message });
  shutdown(1);
}

function shutdown(code = 0) {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 200).unref();
}

// --- POM models -------------------------------------------------------------

async function listPomModels() {
  const headers = { accept: "application/json", authorization: `Bearer ${llmApiKey}` };
  const response = await fetch(`${llmBaseUrl}/models`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GET ${llmBaseUrl}/models returned HTTP ${response.status}`);
  const body = await response.json();
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows
    .map((row) => (typeof row?.id === "string" ? row.id.trim() : ""))
    .filter((id, index, ids) => id && ids.indexOf(id) === index)
    .map((id) => ({ id, name: id }));
}

/**
 * The POM route in the harness's home-level patch layer (JSON is valid YAML).
 * That layer belongs to the plugin (`DSH_HOME` is the plugin's) and the
 * harness reloads it live, so the route follows the models the node serves.
 * Providers the user adds on the harness Models page live in its settings
 * document, which merges per provider over this layer.
 *
 * Only the route lives here. Reloading the `agent-default-model` entry takes
 * the harness session controller down for good, so the default model is a
 * settings value instead (see `ensureDefaultModel`).
 */
export function pomPatch(models, baseURL) {
  if (models.length === 0) return [];
  const provider = { displayName: "POM", api: "openai-completions", baseURL, apiKeyEnv: "DSH_POM_LLM_API_KEY", models };
  return [{ id: "llm-pi-ai", config: { providers: { pom: provider } } }];
}

/**
 * The default model to store, or undefined to leave the user's choice alone:
 * set it when the selection is still the composition default, or when it
 * points at a POM model the node no longer serves.
 */
export function defaultModelChange(current, base, models) {
  if (models.length === 0) return undefined;
  const served = new Set(models.map((model) => model.id));
  const untouched = current?.provider === base?.provider && current?.model === base?.model;
  const stale = current?.provider === "pom" && !served.has(current?.model);
  if ((untouched && current?.provider !== "pom") || stale) return { provider: "pom", model: models[0].id };
  return undefined;
}

/** Rewrite the home-level patch only when its content changes, so the harness reloads only then. */
function writePomPatch(models) {
  const path = join(dshHome, "cordis.patch.yml");
  const text = `${JSON.stringify(pomPatch(models, llmBaseUrl), null, 2)}\n`;
  let current;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = undefined;
  }
  if (current === text) return false;
  writeFileSync(path, text);
  return true;
}

/** Follow the node's model list for as long as the harness runs. */
function followPomModels(initial, session) {
  let known = JSON.stringify(initial.map((model) => model.id));
  const timer = setInterval(async () => {
    let models;
    try {
      models = await listPomModels();
    } catch (error) {
      log(`POM models unavailable: ${error.message}`);
      return;
    }
    const ids = JSON.stringify(models.map((model) => model.id));
    if (ids === known) return;
    known = ids;
    if (writePomPatch(models)) log(`POM models changed: ${ids}`);
    await ensureDefaultModel(session, models).catch((error) => log(`default model not updated: ${error.message}`));
  }, MODEL_POLL_MS);
  timer.unref();
}

/** Static loader overlay (JSON is valid YAML) adapting the stock web profile to run under the POM. */
function writeOverlay() {
  // The browser usually runs on another machine than the POM node, so the
  // workspace picker must be the in-page one, never the node's native dialog.
  const overlay = [
    { id: "directory-picker", disabled: true },
    {
      insert: [
        { id: "directory-picker-browse", name: "@deepseek-ai/dsh-host-directory-picker-browse" },
        { id: "ui-directory-picker-browse", name: "@deepseek-ai/dsh-client-ui-directory-picker-browse" },
      ],
    },
  ];
  const path = join(dataDir, "pom-overlay.yml");
  writeFileSync(path, `${JSON.stringify(overlay, null, 2)}\n`);
  return path;
}

// --- Harness process --------------------------------------------------------

function startHarness(overlay) {
  return new Promise((resolve, reject) => {
    child = spawn(
      process.execPath,
      [dshBin, "--profile", "web", "--patch", overlay, "--no-open", "--host", "127.0.0.1", "--port", "0"],
      {
        cwd: workspace,
        env: { ...env, DSH_HOME: dshHome, HOME: env.HOME || dataDir },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      process.stderr.write(chunk);
      buffered += chunk;
      const match = buffered.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/);
      if (match) {
        buffered = "";
        resolve({ port: Number(match[1]), token: match[2] });
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      reject(new Error(`dsh exited before it was ready (code ${code}, signal ${signal})`));
      if (reported) {
        log(`dsh exited (code ${code}, signal ${signal})`);
        shutdown(code ?? 1);
      }
    });
  });
}

/** Exchange the launch token for the harness session cookie, server side. */
function harnessSession(port, token) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: `/?token=${token}` }, (response) => {
      response.resume();
      const cookies = response.headers["set-cookie"] ?? [];
      const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
      if (!cookie) reject(new Error(`harness token exchange returned HTTP ${response.statusCode} without a cookie`));
      else resolve(cookie);
    });
    request.on("error", reject);
  });
}

/** One unary call to the harness's Remote API, with the server-side session. */
async function harnessCall({ port, cookie }, endpoint, args) {
  const response = await fetch(`http://127.0.0.1:${port}/api/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: endpoint, payload: { args } }),
  });
  const reply = await response.json().catch(() => undefined);
  if (reply?.result?.ok !== true) {
    throw new Error(`${endpoint} failed: ${JSON.stringify(reply?.result?.error ?? response.status)}`);
  }
  return reply.result.value;
}

/**
 * Register the plugin's working directory as a Workspace through the
 * harness's own Remote API (idempotent), so a session can start right away.
 */
function registerWorkspace(session) {
  return harnessCall(session, "workspace/create", { request: { path: workspace } });
}

/** Point new agents at a POM model through the settings the model picker also writes. */
async function ensureDefaultModel(session, models) {
  const described = await harnessCall(session, "settings/describe", {});
  const namespace = described.namespaces.find((entry) => entry.ns === "agent-default-model");
  if (!namespace) return;
  const change = defaultModelChange(namespace.value, namespace.base, models);
  if (!change) return;
  await harnessCall(session, "settings/update", {
    ns: "agent-default-model",
    patch: change,
    expectedRevision: namespace.revision,
  });
  log(`default model set to pom/${change.model}`);
}

// --- Proxy --------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade",
]);

function tokenMatches(candidate) {
  if (typeof candidate !== "string") return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(candidate);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The request target, exactly as the node forwarded it. */
export function forwardedPath(rawUrl) {
  return rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
}

/** Where the node mounted this proxy, from `x-forwarded-prefix`; empty when absent or unexpected. */
export function mountPrefix(value) {
  return typeof value === "string" && MOUNT_PREFIX.test(value) ? value : "";
}

/**
 * Redirect every browser base the harness derives from `location` to
 * `__DSH_POM__`. The harness also keeps its settings browser-local unless the
 * page is on a loopback host; under the POM the only client of the harness is
 * the node's admin-only proxy on loopback, so a POM-mounted page counts as one.
 */
export function rewriteScript(source) {
  return source
    .replaceAll(
      "isLoopbackHostname(pageLocation.hostname)",
      "(globalThis.__DSH_POM__ !== void 0 || isLoopbackHostname(pageLocation.hostname))",
    )
    .replaceAll('getElementById("root")', 'getElementById("dsh-root")')
    .replaceAll("globalThis.location?.origin", "(globalThis.__DSH_POM__?.origin ?? globalThis.location?.origin)")
    .replaceAll("window.location.origin", "(globalThis.__DSH_POM__?.origin ?? window.location.origin)")
    .replace(/const location = globalThis\.location;/g, "const location = globalThis.__DSH_POM__ ?? globalThis.location;")
    .replaceAll("new EventSource(EVENTS_ENDPOINT)", "new EventSource(new URL(EVENTS_ENDPOINT, globalThis.__DSH_POM__ ?? location.href))");
}

function upstreamHeaders(request, upstream, cookie) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (HOP_BY_HOP.has(name) || name.startsWith("x-forwarded-") || name === TOKEN_HEADER || name === "cookie" || name === "referer") continue;
    headers[name] = value;
  }
  headers.host = upstream;
  headers.cookie = cookie;
  headers["accept-encoding"] = "identity";
  if (headers.origin) headers.origin = `http://${upstream}`;
  if (headers["sec-fetch-site"]) headers["sec-fetch-site"] = "same-origin";
  return headers;
}

/**
 * The harness index, decomposed into the ordered boot steps the plugin
 * screen replays inside the POM document, with every URL made root-relative
 * under the node's mount prefix.
 */
export function bootPlan(html, prefix) {
  const steps = [];
  const styles = [];
  const absolute = (value) => {
    const decoded = value.replaceAll("&amp;", "&");
    // Root-relative harness paths keep their shape under the prefix; the URL
    // parser would drop the prefix and re-encode the `/plugins/??` query.
    if (decoded.startsWith("/")) return `${prefix}${decoded}`;
    const url = new URL(decoded, `http://mount.invalid${prefix}/`);
    return `${url.pathname}${url.search}`;
  };
  const tag = /<script\b([^>]*)>([\s\S]*?)<\/script>|<link\b([^>]*)>/gi;
  for (const match of html.matchAll(tag)) {
    if (match[3] !== undefined) {
      const rel = match[3].match(/\brel="([^"]+)"/)?.[1];
      const href = match[3].match(/\bhref="([^"]+)"/)?.[1];
      if (rel === "stylesheet" && href) styles.push(absolute(href));
      continue;
    }
    const attributes = match[1];
    const src = attributes.match(/\bsrc="([^"]+)"/)?.[1];
    if (src) {
      steps.push({ kind: /\btype="module"/.test(attributes) ? "module" : "script", url: absolute(src) });
    } else if (match[2].trim()) {
      const code = rewriteScript(match[2]).replace(/"url":"\//g, `"url":"${prefix}/`);
      steps.push({ kind: "inline", code });
    }
  }
  return { prefix, steps, styles };
}

function startProxy(port, cookie) {
  const upstream = `127.0.0.1:${port}`;
  const server = http.createServer((request, response) => {
    if (!tokenMatches(request.headers[TOKEN_HEADER])) {
      response.writeHead(401, { "content-type": "text/plain" }).end("missing or invalid plugin token");
      return;
    }
    const path = forwardedPath(request.url);
    const isBoot = new URL(path, "http://proxy.invalid").pathname === "/__pom/boot";
    const prefix = mountPrefix(request.headers[PREFIX_HEADER]);

    const outbound = http.request(
      {
        host: "127.0.0.1",
        port,
        method: isBoot ? "GET" : request.method,
        path: isBoot ? "/" : path,
        headers: upstreamHeaders(request, upstream, cookie),
      },
      (reply) => {
        const headers = {};
        for (const [name, value] of Object.entries(reply.headers)) {
          if (HOP_BY_HOP.has(name) || name === "set-cookie" || name === "cross-origin-resource-policy") continue;
          headers[name] = value;
        }
        const type = String(reply.headers["content-type"] || "");
        const rewrite = isBoot || /javascript/.test(type);
        if (!rewrite || reply.statusCode < 200 || reply.statusCode >= 300) {
          response.writeHead(reply.statusCode, headers);
          reply.pipe(response);
          return;
        }
        const chunks = [];
        reply.on("data", (chunk) => chunks.push(chunk));
        reply.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const body = isBoot ? JSON.stringify(bootPlan(text, prefix)) : rewriteScript(text);
          delete headers.etag;
          headers["content-type"] = isBoot ? "application/json" : type;
          headers["content-length"] = Buffer.byteLength(body);
          headers["cache-control"] = "no-store";
          response.writeHead(200, headers).end(body);
        });
      },
    );
    outbound.on("error", (error) => {
      log(`proxy ${request.method} ${path}: ${error.message}`);
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(outbound);
  });

  server.on("upgrade", (request, socket, head) => {
    if (!tokenMatches(request.headers[TOKEN_HEADER])) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
      return;
    }
    const headers = upstreamHeaders(request, upstream, cookie);
    delete headers["accept-encoding"];
    headers.connection = "Upgrade";
    headers.upgrade = request.headers.upgrade;
    const lines = [`${request.method} ${forwardedPath(request.url)} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
    }
    const target = net.connect(port, "127.0.0.1", () => {
      target.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    });
    const close = () => {
      target.destroy();
      socket.destroy();
    };
    target.on("error", close);
    socket.on("error", close);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

// --- Main -------------------------------------------------------------------

async function main() {
  if (!llmBaseUrl || !llmApiKey) throw new Error("the POM did not provide DSH_POM_LLM_BASE_URL and DSH_POM_LLM_API_KEY");
  for (const directory of [dataDir, dshHome, workspace]) mkdirSync(directory, { recursive: true });
  let models = [];
  let warning;
  try {
    models = await listPomModels();
    if (models.length === 0) warning = `${llmBaseUrl}/models listed no models yet`;
  } catch (error) {
    warning = `POM models unavailable: ${error.message}`;
  }
  if (warning) log(warning);
  writePomPatch(models);
  const harness = await startHarness(writeOverlay());
  const cookie = await harnessSession(harness.port, harness.token);
  const session = { port: harness.port, cookie };
  for (const step of [() => registerWorkspace(session), () => ensureDefaultModel(session, models)]) {
    await step().catch((error) => {
      warning = [warning, error.message].filter(Boolean).join("; ");
      log(error.message);
    });
  }
  const port = await startProxy(harness.port, cookie);
  followPomModels(models, session);
  log(`proxy on 127.0.0.1:${port} -> harness 127.0.0.1:${harness.port}; ${models.length} POM model(s)`);
  report({ status: "ready", port, token, models: models.map((model) => model.id), warning });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdin.on("end", () => shutdown(0));
  process.stdin.on("error", () => shutdown(0));
  process.stdin.resume();
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => shutdown(0));
  main().catch(fail);
}
