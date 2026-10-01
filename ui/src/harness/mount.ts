// Boots the official DeepSeek Harness web client inside a POM screen.
//
// The harness client expects to own a whole page. The POM node serves it
// through its admin-only plugin proxy at `/api/ui/plugins/<code>/proxy`, on
// the POM's own origin, so the POM session authenticates every request. The
// plugin's launcher already rewrote the harness bundles so their page origin
// and `#root` are replaceable; this module supplies the rest: the harness
// origin (`__DSH_POM__`, a placeholder host mapped onto the proxy route), CSS
// confined to the harness containers, and a replay of the harness index boot
// steps inside the POM document. Harness portals (dialogs, menus, notices)
// that it appends to <body> are routed into `#dsh-portals`, so they get the
// harness styles and never push the POM layout. Its light/dark theme and
// language follow the POM (`pomContext.ts`). The client can be booted once per page load, so leaving
// the screen parks the live container and returning re-attaches the same one.

import { installPomContext, restorePomLanguage } from "./pomContext.ts";
import { scopeCss } from "./scopeCss.ts";

declare const __POM_PLUGIN_CODE__: string;

export const ROOT_ID = "dsh-root";
export const PORTALS_ID = "dsh-portals";
const SCOPE = `:is(#${ROOT_ID}, #${PORTALS_ID})`;
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
let portals: HTMLElement | null = null;
/** Class names the harness stylesheets define; CSS Modules names always carry an underscore. */
const harnessClasses = new Set<string>();

function learnClasses(css: string): void {
  for (const match of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
    if (match[1].includes("_")) harnessClasses.add(match[1]);
  }
}

/** A node the harness renders into <body>: its own or a nested element uses harness classes. */
export function isHarnessNode(node: Node, classes: ReadonlySet<string> = harnessClasses): boolean {
  if (!(node instanceof Element)) return false;
  const owns = (element: Element) => Array.from(element.classList).some((name) => classes.has(name));
  if (owns(node)) return true;
  const nested = node.querySelectorAll("[class]");
  for (let index = 0; index < nested.length && index < 50; index += 1) {
    if (owns(nested[index])) return true;
  }
  return false;
}

/**
 * React mounts harness portals into document.body and later removes them
 * from it. Route those nodes into `#dsh-portals` and follow them there on
 * removal; every other <body> child (the POM's own portals) is untouched.
 */
function routePortals(): void {
  portals = document.createElement("div");
  portals.id = PORTALS_ID;
  // Out of the POM's flow and zero-sized: the harness root rules (height,
  // background) also match this container, and portal content positions
  // itself against the viewport anyway.
  for (const [property, value] of [
    ["position", "fixed"],
    ["inset", "0 auto auto 0"],
    ["width", "0"],
    ["height", "0"],
    ["overflow", "visible"],
    ["background", "none"],
    ["z-index", "1000"],
  ]) {
    portals.style.setProperty(property, value, "important");
  }
  const body = document.body;
  const appendChild = body.appendChild.bind(body);
  const insertBefore = body.insertBefore.bind(body);
  const removeChild = body.removeChild.bind(body);
  appendChild(portals);
  body.appendChild = <T extends Node>(node: T): T =>
    portals && node !== portals && isHarnessNode(node) ? portals.appendChild(node) : appendChild(node);
  body.insertBefore = <T extends Node>(node: T, child: Node | null): T => {
    if (portals && node !== portals && isHarnessNode(node)) {
      return portals.insertBefore(node, child?.parentNode === portals ? child : null);
    }
    return insertBefore(node, child);
  };
  body.removeChild = <T extends Node>(child: T): T =>
    portals && child.parentNode === portals ? portals.removeChild(child) : removeChild(child);
}

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
  const scope = globalThis as typeof globalThis & { __DSH_POM__?: URL; __DSH_POM_BASE__?: string };
  scope.__DSH_POM__ = new URL(HARNESS_ORIGIN);
  // Base for URLs the harness resolves against `document.baseURI` (stream
  // socket, uploads, media); the launcher rewrites those reads to use it.
  scope.__DSH_POM_BASE__ = `${location.origin}${PROXY_PREFIX}/`;

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

  // Bundles the module loader adds at run time (`<script src="plugins/??...">`,
  // document-relative since dsh 0.1.7) would resolve against the POM page.
  const scriptSrc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src");
  if (scriptSrc?.set && scriptSrc.get) {
    const nativeSet = scriptSrc.set;
    Object.defineProperty(HTMLScriptElement.prototype, "src", {
      ...scriptSrc,
      set(this: HTMLScriptElement, value: string) {
        nativeSet.call(this, String(toProxyUrl(value)));
      },
    });
  }
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function setAttribute(this: Element, name: string, value: string) {
    const mapped = this instanceof HTMLScriptElement && name.toLowerCase() === "src" ? String(toProxyUrl(value)) : value;
    nativeSetAttribute.call(this, name, mapped);
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
  learnClasses(node.textContent ?? "");
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
  const css = await response.text();
  learnClasses(css);
  style.textContent = scopeCss(css, SCOPE, new URL(url, location.href).href);
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
  // Before any client script runs: its theme and locale read these at startup.
  installPomContext(__POM_PLUGIN_CODE__);
  installBridges();
  confineInjectedStyles();
  routePortals();
  const response = await fetch(`${PROXY_PREFIX}/__pom/boot`);
  if (!response.ok) throw new Error(`harness boot plan: HTTP ${response.status}`);
  const plan = (await response.json()) as BootPlan;
  await Promise.all(plan.styles.map(addStylesheet));
  for (const step of plan.steps) await runScript(step);
  restorePomLanguage();
}

/** Attach the harness to `slot`, booting it on first use. */
export async function mountHarness(slot: HTMLElement): Promise<void> {
  if (!root) {
    root = document.createElement("div");
    root.id = ROOT_ID;
  }
  root.hidden = false;
  if (portals) portals.hidden = false;
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
  if (portals) portals.hidden = true;
  document.body.appendChild(root);
}
