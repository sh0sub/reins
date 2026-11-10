import { domainToASCII } from "node:url";

/**
 * Public suffixes Reins knows about (H2/H3). Not the full Mozilla list: the generic TLDs agents meet most, the common
 * two-level country suffixes, and multi-tenant hosting platforms where every customer gets a subdomain. Any single
 * label (a bare TLD such as "shop") also counts as a public suffix.
 */
export const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  // generic and country TLDs that show up in merchant names
  "com", "net", "org", "io", "co", "ai", "app", "dev", "xyz", "me", "info", "biz", "shop", "store", "online", "site", "tech",
  "us", "uk", "de", "fr", "jp", "kr", "cn", "in", "au", "ca", "br", "nz", "eu", "es", "it", "nl", "se", "ch",
  // two-level country suffixes
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "co.jp", "ne.jp", "or.jp", "ac.jp",
  "co.kr", "or.kr", "ne.kr", "go.kr", "ac.kr",
  "com.au", "net.au", "org.au", "com.br", "com.cn", "com.mx", "com.tr", "com.sg", "com.hk", "com.tw",
  "co.nz", "co.in", "co.za", "co.id",
  // multi-tenant hosting: alice.github.io and bob.github.io are different owners
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "fly.dev", "web.app", "firebaseapp.com",
  "herokuapp.com", "onrender.com", "azurewebsites.net", "cloudfront.net", "appspot.com", "blogspot.com", "myshopify.com",
  "s3.amazonaws.com", "ngrok.io", "ngrok-free.app", "replit.app", "glitch.me", "surge.sh", "deno.dev",
]);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class InvalidMerchantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMerchantError";
  }
}

/** Lenient clean-up used for comparisons: "https://www.Namecheap.com:443/renew" -> "namecheap.com". Never throws. */
export function normalizeMerchant(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\/\//, "");
  s = s.split(/[/?#]/)[0] ?? s;
  s = s.replace(/:\d*$/, "");
  s = s.replace(/\.+$/, "");
  s = s.replace(/^www\./, "");
  if (/[\u0080-\uffff]/.test(s)) s = domainToASCII(s) || s;
  return s;
}

/**
 * H1 strict merchant hostname: normalizes like normalizeMerchant (lowercase, scheme, path, port, trailing dots,
 * "www.", IDN to punycode), then requires a real hostname: at least two labels, letters/digits/hyphens only, no
 * empty label, a TLD that is not all digits (no IP addresses). Throws InvalidMerchantError otherwise.
 */
export function parseMerchant(input: string): string {
  const raw = String(input ?? "");
  if (!raw.trim()) throw new InvalidMerchantError("merchant must be a domain such as namecheap.com");
  if (/[@\\\s]/.test(raw.trim())) throw new InvalidMerchantError(`"${raw.trim().slice(0, 80)}" is not a merchant domain`);
  const host = normalizeMerchant(raw);
  const ascii = host && /[\u0080-\uffff]/.test(host) ? domainToASCII(host) : host;
  const labels = ascii.split(".");
  const valid =
    ascii.length > 0 &&
    ascii.length <= 253 &&
    labels.length >= 2 &&
    labels.every((l) => LABEL.test(l)) &&
    !/^\d+$/.test(labels.at(-1)!);
  if (!valid) throw new InvalidMerchantError(`"${raw.trim().slice(0, 80)}" is not a merchant domain (expected something like namecheap.com)`);
  return ascii;
}

/** H2: a bare TLD or a known public suffix (co.uk, github.io, vercel.app ...). Nobody owns these as a merchant. */
export function isPublicSuffix(host: string): boolean {
  const h = normalizeMerchant(host);
  return !h.includes(".") || PUBLIC_SUFFIXES.has(h);
}

/**
 * H3 registrable domain (simple eTLD+1): the longest known public suffix the host ends with, plus one label.
 * Unknown suffixes fall back to the last label, so "api.vercel.com" -> "vercel.com", "a.b.co.uk" -> "b.co.uk",
 * "alice.github.io" -> "alice.github.io". A host that is itself a public suffix is returned unchanged.
 */
export function registrableDomain(host: string): string {
  const h = normalizeMerchant(host);
  const labels = h.split(".");
  if (labels.length < 2) return h;
  let suffixLen = 1;
  for (let n = labels.length - 1; n >= 2; n--) {
    if (PUBLIC_SUFFIXES.has(labels.slice(-n).join("."))) {
      suffixLen = n;
      break;
    }
  }
  if (labels.length <= suffixLen) return h;
  return labels.slice(-(suffixLen + 1)).join(".");
}

/** True if merchant equals a list entry or is a subdomain of one. */
export function merchantInList(merchant: string, list: readonly string[]): boolean {
  const m = normalizeMerchant(merchant);
  return list.some((entry) => {
    const e = normalizeMerchant(entry);
    return e.length > 0 && (m === e || m.endsWith(`.${e}`));
  });
}
