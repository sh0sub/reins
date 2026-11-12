/**
 * M1 per-IP token buckets for the public, unauthenticated entry points (/api/try, /api/demo/request, the checkout
 * return and the webhooks). In memory per server process: the public demo is one free Render instance.
 */
export const RATE_LIMITS = {
  /** The judge tour sends about ten requests, five of them back to back. */
  try: { capacity: 30, refillPerMinute: 30 },
  /** /try re-reads its own paying rows every 2 s for up to 3 minutes (one call covers every id of a multi-order run). */
  tryRead: { capacity: 60, refillPerMinute: 60 },
  demo: { capacity: 5, refillPerMinute: 5 },
  /** Per-visitor demo keys (/api/try/connect): a few page loads, not a key factory. */
  connect: { capacity: 10, refillPerMinute: 5 },
  checkout: { capacity: 20, refillPerMinute: 20 },
  webhook: { capacity: 120, refillPerMinute: 120 },
} as const;

type Bucket = { tokens: number; at: number };

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(
    private readonly limits: Record<string, { capacity: number; refillPerMinute: number }> = RATE_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one token. Returns 0 when allowed, otherwise the milliseconds until the next token. */
  take(name: string, ip: string): number {
    const limit = this.limits[name];
    if (!limit) return 0;
    const key = `${name}:${ip}`;
    const t = this.now();
    const perMs = limit.refillPerMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: limit.capacity, at: t };
    b.tokens = Math.min(limit.capacity, b.tokens + (t - b.at) * perMs);
    b.at = t;
    if (this.buckets.size > 10_000) this.buckets.clear(); // bounded memory under a flood of spoofed addresses
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return Math.ceil((1 - b.tokens) / perMs);
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return 0;
  }
}

/**
 * Client address: the edge's own header (Render sits behind Cloudflare) when present, else the first hop of
 * X-Forwarded-For, else X-Real-IP, else one shared bucket. XFF can be forged, so the daily Claude cap (claudeBudget.ts)
 * stays the hard bound on cost; these buckets only stop casual floods.
 */
export function clientIp(req: Request): string {
  const edge = req.headers.get("cf-connecting-ip") ?? req.headers.get("true-client-ip");
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return edge?.trim() || fwd || req.headers.get("x-real-ip")?.trim() || "local";
}
