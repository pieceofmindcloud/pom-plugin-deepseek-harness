// Confines harness CSS to its container. The browser's own parser reads the
// sheet; every top-level style rule (also inside @media, @supports, @layer and
// @container) gets its selectors rewritten, and relative url() references are
// resolved against the harness origin instead of the POM page.

const ROOT_COMPOUND = /^((?:html|:root|body)(?![\w-])(?:\[[^\]]*\]|\((?:[^()]|\([^()]*\))*\)|[^\s>+~[(,])*)\s*(?:[>+~]\s*)?/;
const BARE_ROOT = /^(?:html|:root|body)$/;

/** Split a selector list on commas outside parentheses and brackets. */
export function splitSelectorList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    const char = list[index];
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(list.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Scope one selector under `scope`. Document-root compounds (`html`, `:root`,
 * `body`) become the scope itself when bare; qualified ones such as
 * `body[data-ds-dark-theme]` stay, because the harness still sets those
 * attributes on the real document, and the scope is placed below them.
 */
export function scopeSelector(selector: string, scope: string): string {
  const source = selector.trim().replace(/#root(?![\w-])/g, scope);
  if (source === scope || source.startsWith(`${scope} `) || source.startsWith(`${scope}:`)) return source;
  const roots: string[] = [];
  let qualified = false;
  let rest = source;
  for (let match = rest.match(ROOT_COMPOUND); match; match = rest.match(ROOT_COMPOUND)) {
    roots.push(match[1]);
    if (!BARE_ROOT.test(match[1])) qualified = true;
    rest = rest.slice(match[0].length);
  }
  if (roots.length === 0) return `${scope} ${source}`;
  const head = qualified ? `${roots.join(" ")} ${scope}` : scope;
  return rest ? `${head} ${rest}` : head;
}

export function scopeSelectorList(list: string, scope: string): string {
  return splitSelectorList(list).map((selector) => scopeSelector(selector, scope)).join(", ");
}

function scopeRules(rules: CSSRuleList, scope: string): void {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      rule.selectorText = scopeSelectorList(rule.selectorText, scope);
    } else if ("cssRules" in rule && !(rule instanceof CSSKeyframesRule)) {
      scopeRules((rule as CSSGroupingRule).cssRules, scope);
    }
  }
}

export function rebaseUrls(css: string, base: string): string {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (whole, quote: string, value: string) => {
    if (/^(?:data:|blob:|[a-z][a-z0-9+.-]*:\/\/|#)/i.test(value)) return whole;
    return `url(${quote || '"'}${new URL(value, base).href}${quote || '"'})`;
  });
}

export function scopeCss(css: string, scope: string, base: string): string {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  scopeRules(sheet.cssRules, scope);
  return rebaseUrls(Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n"), base);
}
