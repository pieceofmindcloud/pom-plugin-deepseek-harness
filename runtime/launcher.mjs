// Supervisor of the official DeepSeek Harness inside the POM plugin.
//
// The plugin library starts this script with the Node runtime shipped next to
// it. It boots the unmodified `dsh web` server on a private loopback port,
// points its pi-ai provider at the POM OpenAI-compatible endpoint, and fronts
// it with a small proxy the POM page can reach cross-origin. The proxy is the
// only place that adapts the harness to run inside a POM <div>:
//
// - every browser base the harness derives from `location` is redirected to
//   `globalThis.__DSH_POM__` (set by the plugin screen to this proxy origin);
// - the harness mount point `#root` becomes `#dsh-root` (the POM owns #root);
// - the harness browser session is established here, server side, so the
//   browser only presents the per-launch key the plugin publishes.
//
// Protocol with the plugin library: exactly one JSON line on stdout once
// ready (`{"status":"ready","port":N,"key":"..."}`) or failed
// (`{"status":"error","error":"..."}`). Logs go to stderr. The process exits
// when stdin closes, so it never outlives the plugin host.

import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const dataDir = env.DSH_POM_DATA_DIR || join(here, "data");
const dshHome = join(dataDir, "dsh-home");
const workspace = env.DSH_POM_WORKSPACE || join(dataDir, "workspace");
const proxyHost = env.DSH_POM_PROXY_HOST || "127.0.0.1";
const proxyPort = Number(env.DSH_POM_PROXY_PORT || 0);
const llmBaseUrl = (env.DSH_POM_LLM_BASE_URL || "http://127.0.0.1:8080/v1").replace(/\/+$/, "");
const llmApiKey = env.DSH_POM_LLM_API_KEY || "";
// pi-ai refuses a keyless route, so an endpoint that needs no key gets a placeholder.
const routeApiKey = llmApiKey || "pom-no-key";
const dshBin = join(here, "app", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const KEY_HEADER = "x-dsh-pom-key";
const KEY_PARAM = "dsh_pom_key";
const key = randomBytes(32).toString("base64url");

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

async function pomModels() {
  const headers = { accept: "application/json" };
  if (llmApiKey) headers.authorization = `Bearer ${llmApiKey}`;
  const response = await fetch(`${llmBaseUrl}/models`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GET ${llmBaseUrl}/models returned HTTP ${response.status}`);
  const body = await response.json();
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows
    .map((row) => (typeof row?.id === "string" ? row.id.trim() : ""))
    .filter((id, index, ids) => id && ids.indexOf(id) === index)
    .map((id) => ({ id, name: id }));
}

/** Loader overlay (JSON is valid YAML) adapting the stock web profile to run under the POM. */
function writeOverlay(models) {
  const provider = {
    displayName: "POM",
    api: "openai-completions",
    baseURL: llmBaseUrl,
    apiKeyEnv: "DSH_POM_LLM_API_KEY",
    models,
  };
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
  if (models.length > 0) {
    overlay.push({ id: "llm-pi-ai", config: { providers: { pom: provider } } });
    // Fresh agents start on a POM model; a selection saved in the harness settings still wins.
    overlay.push({ id: "agent-default-model", config: { provider: "pom", model: models[0].id } });
  }
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
        env: { ...env, DSH_HOME: dshHome, HOME: env.HOME || dataDir, DSH_POM_LLM_API_KEY: routeApiKey },
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

/**
 * Register the plugin's working directory as a Workspace through the
 * harness's own Remote API (idempotent), so a session can start right away.
 */
async function registerWorkspace(port, cookie) {
  const response = await fetch(`http://127.0.0.1:${port}/api/workspace/create`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({
      type: "client-request",
      rpcId: randomUUID(),
      method: "workspace/create",
      payload: { args: { request: { path: workspace } } },
    }),
  });
  const reply = await response.json().catch(() => undefined);
  if (reply?.result?.ok !== true) {
    throw new Error(`workspace registration failed: ${JSON.stringify(reply?.result?.error ?? response.status)}`);
  }
}

// --- Proxy --------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade",
]);

function keyMatches(candidate) {
  if (typeof candidate !== "string") return false;
  const expected = Buffer.from(key);
  const actual = Buffer.from(candidate);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Static harness code needs no key: classic <script> and CSS loads cannot carry headers. */
function isPublic(method, url) {
  if (method !== "GET" && method !== "HEAD") return false;
  if (url.pathname.startsWith("/assets/") || url.pathname === "/favicon.svg") return true;
  return url.pathname === "/plugins/" && url.search.startsWith("??");
}

/** The request target without the key parameter, leaving every other byte of the query intact. */
export function forwardedPath(rawUrl) {
  const [path, query] = rawUrl.split(/\?(.*)/s, 2);
  if (query === undefined) return path;
  const kept = query.split("&").filter((part) => !part.startsWith(`${KEY_PARAM}=`));
  return kept.length > 0 ? `${path}?${kept.join("&")}` : path;
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": request.headers["access-control-request-headers"] || "*",
    "access-control-expose-headers": "*",
    "access-control-allow-private-network": "true",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

/** Redirect every browser base the harness derives from `location` to the proxy. */
export function rewriteScript(source) {
  return source
    .replaceAll('getElementById("root")', 'getElementById("dsh-root")')
    .replaceAll("globalThis.location?.origin", "(globalThis.__DSH_POM__?.origin ?? globalThis.location?.origin)")
    .replaceAll("window.location.origin", "(globalThis.__DSH_POM__?.origin ?? window.location.origin)")
    .replace(/const location = globalThis\.location;/g, "const location = globalThis.__DSH_POM__ ?? globalThis.location;")
    .replaceAll("new EventSource(EVENTS_ENDPOINT)", "new EventSource(new URL(EVENTS_ENDPOINT, globalThis.__DSH_POM__ ?? location.href))");
}

function upstreamHeaders(request, upstream, cookie) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (HOP_BY_HOP.has(name) || name === KEY_HEADER || name === "cookie" || name === "referer") continue;
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
 * screen replays inside the POM document, with every URL made absolute.
 */
function bootPlan(html, base) {
  const steps = [];
  const styles = [];
  const absolute = (value) => new URL(value.replaceAll("&amp;", "&"), `${base}/`).href;
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
      const code = rewriteScript(match[2]).replace(/"url":"\//g, `"url":"${base}/`);
      steps.push({ kind: "inline", code });
    }
  }
  return { base, steps, styles };
}

function startProxy(port, cookie) {
  const upstream = `127.0.0.1:${port}`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://proxy.invalid");
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors).end();
      return;
    }
    const presented = request.headers[KEY_HEADER] ?? url.searchParams.get(KEY_PARAM);
    if (!isPublic(request.method, url) && !keyMatches(presented)) {
      response.writeHead(401, { ...cors, "content-type": "text/plain" }).end("missing or invalid plugin key");
      return;
    }
    const path = forwardedPath(request.url);
    const isBoot = url.pathname === "/__pom/boot";

    const outbound = http.request(
      {
        host: "127.0.0.1",
        port,
        method: isBoot ? "GET" : request.method,
        path: isBoot ? "/" : path,
        headers: upstreamHeaders(request, upstream, cookie),
      },
      (reply) => {
        const headers = { ...cors };
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
          const base = `http://${request.headers.host}`;
          const body = isBoot ? JSON.stringify(bootPlan(text, base)) : rewriteScript(text);
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
      if (!response.headersSent) response.writeHead(502, cors);
      response.end();
    });
    request.pipe(outbound);
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://proxy.invalid");
    if (!keyMatches(url.searchParams.get(KEY_PARAM))) {
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
    server.listen(proxyPort, proxyHost, () => resolve(server.address().port));
  });
}

// --- Main -------------------------------------------------------------------

async function main() {
  for (const directory of [dataDir, dshHome, workspace]) mkdirSync(directory, { recursive: true });
  let models = [];
  let warning;
  try {
    models = await pomModels();
    if (models.length === 0) warning = `${llmBaseUrl}/models listed no models`;
  } catch (error) {
    warning = `POM models unavailable: ${error.message}`;
  }
  if (warning) log(warning);
  const harness = await startHarness(writeOverlay(models));
  const cookie = await harnessSession(harness.port, harness.token);
  await registerWorkspace(harness.port, cookie).catch((error) => {
    warning = [warning, error.message].filter(Boolean).join("; ");
    log(error.message);
  });
  const port = await startProxy(harness.port, cookie);
  log(`proxy on ${proxyHost}:${port} -> harness 127.0.0.1:${harness.port}; ${models.length} POM model(s)`);
  report({ status: "ready", port, key, models: models.map((model) => model.id), warning });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdin.on("end", () => shutdown(0));
  process.stdin.on("error", () => shutdown(0));
  process.stdin.resume();
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => shutdown(0));
  main().catch(fail);
}
