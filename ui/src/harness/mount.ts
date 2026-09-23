// Boots the official DeepSeek Harness web client inside a POM screen.
//
// The harness client expects to own a whole page. The POM node serves it
// through its admin-only plugin proxy at `/api/ui/plugins/<code>/proxy`, on
// the POM's own origin, so the POM session authenticates every request. The
// plugin's launcher already rewrote the harness bundles so their page origin
// and `#root` are replaceable; this module supplies the rest: the harness
// origin (`__DSH_POM__`, a placeholder host mapped onto the proxy route), CSS
// confined to `#dsh-root`, and a replay of the harness index boot steps inside
// the POM document. The client can be booted once per page load, so leaving
// the screen parks the live container and returning re-attaches the same one.

import { scopeCss } from "./scopeCss.ts";

declare const __POM_PLUGIN_CODE__: string;

export const ROOT_ID = "dsh-root";
const SCOPE = `#${ROOT_ID}`;
const HARNESS_STYLE = "style[data-plugin], style[data-dyn]";
/** The origin the harness believes it runs on; never resolved on the network. */
const HARNESS_ORIGIN = "http://dsh-harness.invalid";
/** The POM route that proxies to the harness. */
export const PROXY_PREFIX = `/api/ui/plugins/${__POM_PLUGIN_CODE__}/proxy`;

type BootStep = { kind: "inline"; code: string } | { kind: "script" | "module"; url: string };
type BootPlan = { prefix: string; steps: BootStep[]; styles: string[] };
type Page = Pick<Location, "origin" | "href" | "protocol" | "host">;

let booted: Promise<void> | null = null;
// Held here, not looked up: React detaches the screen before its cleanup runs.
let root: HTMLElement | null = null;

/**
 * Map a URL the harness built onto the POM proxy route. The harness derives
 * absolute URLs from `__DSH_POM__` (the placeholder origin) and posts its RPC
 * to document-relative `api/<endpoint>`; both land under the proxy prefix on
 * the POM's own origin. Anything else is left alone.
 */
export function toProxyUrl(input: string | URL, page: Page = location): string | URL {
  const raw = typeof input === "string" ? input : input.href;
  if (/^(?:api|plugins)\//.test(raw)) return `${page.origin}${PROXY_PREFIX}/${raw}`;
  let url: URL;
  try {
    url = new URL(raw, page.href);
  } catch {
    return input;
  }
  if (url.hostname !== new URL(HARNESS_ORIGIN).hostname) return input;
  const secure = page.protocol === "https:";
  const socket = url.protocol === "ws:" || url.protocol === "wss:";
  const scheme = socket ? (secure ? "wss:" : "ws:") : page.protocol;
  return `${scheme}//${page.host}${PROXY_PREFIX}${url.pathname}${url.search}${url.hash}`;
}

/** Route every harness request through the POM proxy. */
function installBridges(): void {
  const scope = globalThis as typeof globalThis & { __DSH_POM__?: URL };
  scope.__DSH_POM__ = new URL(HARNESS_ORIGIN);

  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (input instanceof Request) {
      const mapped = toProxyUrl(input.url);
      return nativeFetch(mapped === input.url ? input : new Request(mapped, input), init);
    }
    return nativeFetch(toProxyUrl(input), init);
  };

  const NativeWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(toProxyUrl(url), protocols);
    }
  };

  const NativeEventSource = globalThis.EventSource;
  globalThis.EventSource = class extends NativeEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(toProxyUrl(url), init);
    }
  };
}

function scopeStyle(node: Node): void {
  if (!(node instanceof HTMLStyleElement) || !node.matches(HARNESS_STYLE) || node.dataset.dshScoped) return;
  node.dataset.dshScoped = "true";
  node.textContent = scopeCss(node.textContent ?? "", SCOPE, `${location.origin}${PROXY_PREFIX}/`);
}

/** Confine every stylesheet the harness plugins inject into <head>, before it applies. */
function confineInjectedStyles(): void {
  const head = document.head;
  const appendChild = head.appendChild.bind(head);
  const insertBefore = head.insertBefore.bind(head);
  head.appendChild = <T extends Node>(node: T): T => {
    scopeStyle(node);
    return appendChild(node);
  };
  head.insertBefore = <T extends Node>(node: T, child: Node | null): T => {
    scopeStyle(node);
    return insertBefore(node, child);
  };
  new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach(scopeStyle);
  }).observe(head, { childList: true });
}

async function addStylesheet(url: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const style = document.createElement("style");
  style.dataset.dshScoped = "true";
  style.dataset.dshShell = "true";
  style.textContent = scopeCss(await response.text(), SCOPE, new URL(url, location.href).href);
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

async function boot(): Promise<void> {
  installBridges();
  confineInjectedStyles();
  const response = await fetch(`${PROXY_PREFIX}/__pom/boot`);
  if (!response.ok) throw new Error(`harness boot plan: HTTP ${response.status}`);
  const plan = (await response.json()) as BootPlan;
  await Promise.all(plan.styles.map(addStylesheet));
  for (const step of plan.steps) await runScript(step);
}

/** Attach the harness to `slot`, booting it on first use. */
export async function mountHarness(slot: HTMLElement): Promise<void> {
  if (!root) {
    root = document.createElement("div");
    root.id = ROOT_ID;
  }
  root.hidden = false;
  slot.appendChild(root);
  booted ??= boot().catch((error: unknown) => {
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
