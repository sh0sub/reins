import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey, parseBearer, API_KEY_PREFIX } from "../src/keys.ts";
import { centsToValue, toCents } from "../src/money.ts";
import { merchantInList, normalizeMerchant } from "../src/merchant.ts";

describe("M2 agent API keys", () => {
  it("issues rk_live_ keys and stores only a sha256 hash", () => {
    const { key, hash, displayPrefix } = generateApiKey();
    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key).toHaveLength(API_KEY_PREFIX.length + 32);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashApiKey(key));
    expect(hash).not.toContain(key.slice(API_KEY_PREFIX.length));
    expect(displayPrefix).toBe(key.slice(0, API_KEY_PREFIX.length + 4));
  });
  it("never repeats keys", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
    expect(keys.size).toBe(200);
  });
  it("parses Bearer headers", () => {
    expect(parseBearer("Bearer rk_live_abc")).toBe("rk_live_abc");
    expect(parseBearer("bearer   rk_live_abc ")).toBe("rk_live_abc");
    expect(parseBearer("Basic xyz")).toBeNull();
    expect(parseBearer(null)).toBeNull();
  });
});

describe("money", () => {
  it("converts to and from cents", () => {
    expect(toCents("12.98")).toBe(1298);
    expect(toCents("59")).toBe(5900);
    expect(toCents("0.5")).toBe(50);
    expect(toCents(450)).toBe(45000);
    expect(centsToValue(1298)).toBe("12.98");
    expect(centsToValue(5)).toBe("0.05");
  });
  it("rejects bad amounts", () => {
    for (const bad of ["-1", "1.234", "abc", "", "1e3"]) expect(() => toCents(bad)).toThrow();
  });
});

describe("merchant matching", () => {
  it("normalizes urls and matches subdomains", () => {
    expect(normalizeMerchant("https://www.Namecheap.com/renew?x=1")).toBe("namecheap.com");
    expect(merchantInList("api.vercel.com", ["vercel.com"])).toBe(true);
    expect(merchantInList("evilvercel.com", ["vercel.com"])).toBe(false);
    expect(merchantInList("fiverr.com", [])).toBe(false);
  });
});
