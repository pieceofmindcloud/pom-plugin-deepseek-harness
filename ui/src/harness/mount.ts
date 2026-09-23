// Boots the official DeepSeek Harness web client inside a POM screen.
//
// The harness client expects to own a whole page. The plugin's proxy already
// rewrote its bundles so the page origin and `#root` are replaceable; this
// module supplies the rest: the proxy origin (`__DSH_POM__`), the per-launch
// key on every request to the proxy, CSS confined to `#dsh-root`, and a replay
// of the harness index boot steps inside the POM document. The client can be
// booted once per page load, so leaving the screen parks the live container
// and returning to it re-attaches the same one.

import { scopeCss } from "./scopeCss";

export const ROOT_ID = "dsh-root";
const SCOPE = `#${ROOT_ID}`;
const KEY_HEADER = "x-dsh-pom-key";
const KEY_PARAM = "dsh_pom_key";
const HARNESS_STYLE = "style[data-plugin], style[data-dyn]";

export type HarnessRuntime = { status: "ready"; port: number; key: string };
type BootStep = { kind: "inline"; code: string } | { kind: "script" | "module"; url: string };
type BootPlan = { base: string; steps: BootStep[]; styles: string[] };

let booted: Promise<void> | null = null;
// Held here, not looked up: React detaches the screen before its cleanup runs.
let root: HTMLElement | null = null;

/** The proxy is plain HTTP on the POM host name, like the POM node itself. */
export function harnessBase(port: number): string {
  return `http://${location.hostname}:${port}`;
}

/**
 * The harness posts its RPC to document-relative `api/<endpoint>` (and loads
 * `plugins/...` the same way); inside the POM document those must resolve
 * against the harness origin, not the POM route.
 */
function harnessUrl(base: URL, input: string | URL): string | URL {
  return typeof input === "string" && /^(?:api|plugins)\//.test(input) ? new URL(input, base) : input;
}

function belongsTo(base: URL, input: string | URL): boolean {
  try {
    const url = new URL(input, location.href);
    return url.hostname === base.hostname && url.port === base.port;
  } catch {
    return false;
  }
}

function withKeyParam(input: string | URL, key: string): string {
  const url = new URL(input, location.href);
  url.searchParams.set(KEY_PARAM, key);
  return url.href;
}

/** Make every request the harness sends to its origin carry the plugin key. */
function installBridges(base: URL, key: string): void {
  const scope = globalThis as typeof globalThis & { __DSH_POM__?: URL };
  scope.__DSH_POM__ = base;

  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (!(input instanceof Request)) input = harnessUrl(base, input);
    const url = input instanceof Request ? input.url : input;
    if (!belongsTo(base, url)) return nativeFetch(input, init);
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set(KEY_HEADER, key);
    return nativeFetch(new Request(request, { headers, credentials: "omit" }));
  };

  const NativeWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(belongsTo(base, url) ? withKeyParam(url, key) : url, protocols);
    }
  };

  const NativeEventSource = globalThis.EventSource;
  globalThis.EventSource = class extends NativeEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(belongsTo(base, url) ? withKeyParam(url, key) : url, init);
    }
  };
}

function scopeStyle(node: Node, base: string): void {
  if (!(node instanceof HTMLStyleElement) || !node.matches(HARNESS_STYLE) || node.dataset.dshScoped) return;
  node.dataset.dshScoped = "true";
  node.textContent = scopeCss(node.textContent ?? "", SCOPE, `${base}/`);
}

/** Confine every stylesheet the harness plugins inject into <head>, before it applies. */
function confineInjectedStyles(base: string): void {
  const head = document.head;
  const appendChild = head.appendChild.bind(head);
  const insertBefore = head.insertBefore.bind(head);
  head.appendChild = <T extends Node>(node: T): T => {
    scopeStyle(node, base);
    return appendChild(node);
  };
  head.insertBefore = <T extends Node>(node: T, child: Node | null): T => {
    scopeStyle(node, base);
    return insertBefore(node, child);
  };
  new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach((node) => scopeStyle(node, base));
  }).observe(head, { childList: true });
}

async function addStylesheet(url: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const style = document.createElement("style");
  style.dataset.dshScoped = "true";
  style.dataset.dshShell = "true";
  style.textContent = scopeCss(await response.text(), SCOPE, url);
  document.head.appendChild(style);
}

function runScript(step: BootStep): Promise<void> {
  if (step.kind === "module") return import(/* @vite-ignore */ step.url).then(() => undefined);
  const script = document.createElement("script");
  if (step.kind === "inline") {
    script.textContent = step.code;
    document.head.appendChild(script);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    script.src = step.url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`could not load ${step.url}`));
    document.head.appendChild(script);
  });
}

async function boot(runtime: HarnessRuntime): Promise<void> {
  const base = harnessBase(runtime.port);
  installBridges(new URL(base), runtime.key);
  confineInjectedStyles(base);

  const response = await fetch(`${base}/__pom/boot`);
  if (!response.ok) throw new Error(`harness boot plan: HTTP ${response.status}`);
  const plan = (await response.json()) as BootPlan;
  await Promise.all(plan.styles.map(addStylesheet));
  for (const step of plan.steps) await runScript(step);
}

/** Attach the harness to `slot`, booting it on first use. */
export async function mountHarness(runtime: HarnessRuntime, slot: HTMLElement): Promise<void> {
  if (!root) {
    root = document.createElement("div");
    root.id = ROOT_ID;
  }
  root.hidden = false;
  slot.appendChild(root);
  booted ??= boot(runtime).catch((error: unknown) => {
    booted = null;
    throw error;
  });
  await booted;
}

/** Keep the live client alive, hidden and detached from the screen that is unmounting. */
export function parkHarness(): void {
  if (!root) return;
  root.hidden = true;
  document.body.appendChild(root);
}
