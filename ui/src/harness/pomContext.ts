// Keeps the embedded harness client on the POM's language and light/dark
// theme.
//
// The official client decides its appearance itself: with its default "System"
// preference it follows `matchMedia("(prefers-color-scheme: dark)")`, and it
// picks its language from `navigator.languages`, pointing `<html lang>` at its
// own locale. Inside the POM those are the operating system's choices, not the
// user's. This module answers both from the POM instead and follows the POM's
// `pom-plugin-events/v1` protocol (`theme.changed`, `locale.changed` on the
// `pom:plugin-event` DOM channel), so a change in the POM reaches the harness
// without a reload. A theme the user picks explicitly in the harness settings
// still wins, as it does in the stand-alone client.

export type Theme = "light" | "dark";

const EVENTS_PROTOCOL = "pom-plugin-events/v1";
const EVENT_DOM = "pom:plugin-event";
const COLOR_SCHEME = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/i;

type Scheme = "dark" | "light";

type PomEvent = {
  protocol?: unknown;
  type?: unknown;
  target?: unknown;
  payload?: Record<string, unknown>;
};

/** A MediaQueryList for one color-scheme query, answered from the POM theme. */
export class PomColorSchemeQuery extends EventTarget {
  readonly media: string;
  onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null = null;
  private readonly scheme: Scheme;
  private readonly theme: () => Theme;
  private readonly legacy = new Set<(event: MediaQueryListEvent) => unknown>();

  constructor(media: string, scheme: Scheme, theme: () => Theme) {
    super();
    this.media = media;
    this.scheme = scheme;
    this.theme = theme;
  }

  get matches(): boolean {
    return this.theme() === this.scheme;
  }

  addListener(listener: ((event: MediaQueryListEvent) => unknown) | null): void {
    if (listener) this.legacy.add(listener);
  }

  removeListener(listener: ((event: MediaQueryListEvent) => unknown) | null): void {
    if (listener) this.legacy.delete(listener);
  }

  /** Tell every listener that `matches` may have changed. */
  notify(): void {
    const event = Object.assign(new Event("change"), { matches: this.matches, media: this.media }) as MediaQueryListEvent;
    this.dispatchEvent(event);
    this.onchange?.call(this as unknown as MediaQueryList, event);
    for (const listener of this.legacy) listener.call(this, event);
  }
}

/** The POM theme as the shell stamps it on `<html data-theme>`. */
export function pomTheme(root: { dataset: DOMStringMap } = document.documentElement): Theme {
  return root.dataset.theme === "light" ? "light" : "dark";
}

/** The POM language as `<html lang>` carries it before the harness boots. */
export function pomLocale(root: { lang: string } = document.documentElement): string {
  return root.lang || "en";
}

/**
 * Languages to offer the harness for a POM locale. The client ships English
 * and Chinese; the POM locale comes first so a future Portuguese catalog is
 * picked on its own, and English is the explicit fallback.
 */
export function harnessLanguages(locale: string): string[] {
  const primary = locale.split("-")[0];
  return [...new Set([locale, primary, "en"].filter(Boolean))];
}

/** Read a `pom-plugin-events/v1` envelope addressed to every plugin or to `code`. */
export function pomEventValue(detail: unknown, code: string): { type: string; payload: Record<string, unknown> } | null {
  const event = detail as PomEvent | null;
  if (!event || event.protocol !== EVENTS_PROTOCOL || typeof event.type !== "string") return null;
  if (event.target !== "*" && event.target !== code) return null;
  return { type: event.type, payload: event.payload ?? {} };
}

let installed = false;
let theme: Theme = "dark";
let locale = "en";
const queries = new Set<PomColorSchemeQuery>();

/**
 * Install the bridges once, before the harness boots: `matchMedia` answers the
 * color-scheme queries from the POM, `navigator.languages` offers the POM
 * locale, and POM events keep both current.
 */
export function installPomContext(code: string): void {
  if (installed) return;
  installed = true;
  theme = pomTheme();
  locale = pomLocale();

  const nativeMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query: string): MediaQueryList => {
    const scheme = COLOR_SCHEME.exec(query)?.[1]?.toLowerCase() as Scheme | undefined;
    if (!scheme) return nativeMatchMedia(query);
    const list = new PomColorSchemeQuery(query, scheme, () => theme);
    queries.add(list);
    return list as unknown as MediaQueryList;
  };

  for (const property of ["languages", "language"] as const) {
    Object.defineProperty(navigator, property, {
      configurable: true,
      get: () => (property === "languages" ? harnessLanguages(locale) : harnessLanguages(locale)[0]),
    });
  }

  window.addEventListener(EVENT_DOM, (event) => {
    const value = pomEventValue((event as CustomEvent).detail, code);
    if (!value) return;
    if (value.type === "theme.changed" && (value.payload.theme === "light" || value.payload.theme === "dark")) {
      setTheme(value.payload.theme);
    } else if (value.type === "locale.changed" && typeof value.payload.locale === "string") {
      setLocale(value.payload.locale);
    }
  });

  // A POM without the events protocol (host SDK before version 2) still
  // stamps the theme on <html>; follow that attribute as the fallback.
  const host = (globalThis as typeof globalThis & { __POM_HOST__?: { version?: number } }).__POM_HOST__;
  if ((host?.version ?? 1) < 2) {
    new MutationObserver(() => setTheme(pomTheme())).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }
}

function setTheme(next: Theme): void {
  if (next === theme) return;
  theme = next;
  for (const query of queries) query.notify();
}

function setLocale(next: string): void {
  locale = next;
  restorePomLanguage();
  window.dispatchEvent(new Event("languagechange"));
}

/**
 * The client points `<html lang>` at its own locale while booting; the page
 * belongs to the POM, so its language goes back to the POM's.
 */
export function restorePomLanguage(): void {
  if (document.documentElement.lang !== locale) document.documentElement.lang = locale;
}
