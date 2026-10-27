/**
 * Peerly design tokens (pinned copy of peerly-mockup design-tokens.json v0.1.0, checked 2026-10-09).
 * Resolves {alias} references, rejects missing and circular aliases, and renders semantic + component
 * tokens as CSS custom properties. Primitive values never reach UI code directly.
 */
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
interface Token {
  type: string;
  value: Json;
}

const isToken = (v: unknown): v is Token => !!v && typeof v === "object" && "type" in v && "value" in v;
const ALIAS = /^\{([^}]+)\}$/;

export class TokenError extends Error {}

export function lookup(root: Record<string, unknown>, path: string): Token {
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object" || !(part in cur)) throw new TokenError(`Missing token: {${path}}`);
    cur = (cur as Record<string, unknown>)[part];
  }
  if (!isToken(cur)) throw new TokenError(`Not a token: {${path}}`);
  return cur;
}

/** Deep-resolves aliases inside a token value. */
export function resolveValue(root: Record<string, unknown>, value: Json, stack: string[] = []): Json {
  if (typeof value === "string") {
    const m = ALIAS.exec(value);
    if (!m) return value;
    const path = m[1]!;
    if (stack.includes(path)) throw new TokenError(`Circular alias: ${[...stack, path].join(" -> ")}`);
    return resolveValue(root, lookup(root, path).value, [...stack, path]);
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(root, v, stack));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(root, v, stack)]));
  }
  return value;
}

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

function cssValue(type: string, v: Json): string {
  switch (type) {
    case "dimension":
      return typeof v === "number" ? (v === 0 ? "0" : `${v}px`) : String(v);
    case "duration":
      return `${v}ms`;
    case "fontFamily":
      return (Array.isArray(v) ? v : [v]).map((f) => (/\s/.test(String(f)) ? `"${f}"` : String(f))).join(", ");
    case "shadow": {
      const list = (Array.isArray(v) ? v : [v]) as Array<Record<string, number | string>>;
      return list.length ? list.map((s) => `${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${s.color}`).join(", ") : "none";
    }
    default:
      return String(v);
  }
}

/** Returns [name, value] pairs for every semantic and component token. */
export function toCssVariables(root: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (node: unknown, path: string[]) => {
    if (isToken(node)) {
      const resolved = resolveValue(root, node.value, [path.join(".")]);
      const name = `--${path.map(kebab).join("-")}`;
      if (node.type === "typography" && resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
        const t = resolved as Record<string, Json>;
        if (t.fontFamily !== undefined) out.push([`${name}-family`, cssValue("fontFamily", t.fontFamily)]);
        if (t.fontSize !== undefined) out.push([`${name}-size`, cssValue("dimension", t.fontSize)]);
        if (t.fontWeight !== undefined) out.push([`${name}-weight`, String(t.fontWeight)]);
        if (t.lineHeight !== undefined) out.push([`${name}-line-height`, String(t.lineHeight)]);
      } else {
        out.push([name, cssValue(node.type, resolved)]);
      }
      return;
    }
    if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, [...path, k]);
  };
  walk(root.semantic, ["semantic"]);
  walk(root.component, ["component"]);
  return out;
}

export function renderCss(root: Record<string, unknown>, header: string): string {
  const vars = toCssVariables(root)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `/* ${header} */\n:root {\n${vars}\n}\n`;
}
