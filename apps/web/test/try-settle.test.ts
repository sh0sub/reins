import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateWorkspace } from "@reins/db";
import { createTestContext } from "@reins/core/testing";
import { getReceipt, resolvePendingPayments, runPlayground, type LedgerRow } from "@reins/core";
import { createRouter } from "../src/server/router.ts";
import { RateLimiter } from "../src/server/rateLimit.ts";
import { PRESETS } from "../src/app/try/presets.ts";
import { currentStage, isSettling, watchUntilSettled, type SettleRow } from "../src/app/try/settle.ts";
import { timelineItem, timelineSummary } from "../src/app/try/verdict.ts";
import { recordedChip } from "../src/lib/format.ts";
import { KEEPWARM_INTERVAL_MS, startKeepWarm } from "../src/server/keepWarm.ts";

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
const preset = (id: string) => PRESETS.find((p) => p.id === id)!.purchase;
const VISITOR_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const VISITOR_B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const read = (handle: (r: Request) => Promise<Response>, ids: string[], visitor?: string) =>
  handle(new Request(`http://localhost/api/try/requests?ids=${ids.join(",")}`, { headers: visitor ? { cookie: `reins_try=${visitor}` } : {} }));

describe("settle: which rows are still moving", () => {
  it("paying and approved are settling; paid, denied, waiting for a person, checkout open and an unclaimed payout are not", () => {
    const row = (status: string, error: string | null = null): SettleRow => ({ request_id: "r", status, payment: { error } });
    expect(["paying", "approved", "reviewing"].map((s) => isSettling(row(s)))).toEqual([true, true, true]);
    expect(["paid", "denied", "pending_human", "awaiting_buyer", "failed", "expired"].some((s) => isSettling(row(s)))).toBe(false);
    expect(isSettling(row("paying", "unclaimed: PayPal sent the payout"))).toBe(false);
  });

  it("stage: rules for the first second of the request, then the audit; the payout once the answer says paying", () => {
    expect(currentStage("sending", 0)).toBe(0);
    expect(currentStage("sending", 3)).toBe(1);
    expect(currentStage("paying", 0)).toBe(2);
  });

  it("the five-order timeline says Paying while a payout settles, then Paid", () => {
    expect(timelineItem(1, { status: "paying", rules: [] })).toMatchObject({ label: "Paying", tone: "info" });
    expect(timelineSummary([timelineItem(1, { status: "paid", rules: [] }), timelineItem(2, { status: "paying", rules: [] })])).toBe("1 paid, 1 paying");
  });
});

describe("watchUntilSettled (2 s re-read loop)", () => {
  const instant = async () => undefined;

  it("re-reads until every row is final, reporting each read, then stops", async () => {
    const states = [["paying", "paying"], ["paid", "paying"], ["paid", "paid"]];
    const asked: string[][] = [];
    const seen: string[][] = [];
    let i = 0;
    const end = await watchUntilSettled({
      ids: ["a", "b"],
      signal: new AbortController().signal,
      sleep: instant,
      read: async (ids) => {
        asked.push(ids);
        const s = states[i++]!;
        return ids.map((id) => ({ request_id: id, status: id === "a" ? s[0]! : s[1]! }));
      },
      onRows: (rows) => seen.push(rows.map((r) => `${r.request_id}:${r.status}`)),
    });
    expect(end).toBe("settled");
    expect(asked).toEqual([["a", "b"], ["a", "b"], ["b"]]); // a settled after the second read and is not asked again
    expect(seen.at(-1)).toEqual(["b:paid"]);
  });

  it("skips a failed read (network, 429) and keeps going", async () => {
    let n = 0;
    const end = await watchUntilSettled({
      ids: ["a"],
      signal: new AbortController().signal,
      sleep: instant,
      read: async () => {
        if (n++ === 0) throw new Error("Too many requests");
        return [{ request_id: "a", status: "paid" }];
      },
      onRows: () => undefined,
    });
    expect(end).toBe("settled");
    expect(n).toBe(2);
  });

  it("stops after the timeout (about 3 minutes at 2 s) with rows still paying", async () => {
    let t = 0;
    let reads = 0;
    const end = await watchUntilSettled({
      ids: ["a"],
      signal: new AbortController().signal,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      read: async () => {
        reads += 1;
        return [{ request_id: "a", status: "paying" }];
      },
      onRows: () => undefined,
    });
    expect(end).toBe("timeout");
    expect(reads).toBe(90);
  });

  it("stops when aborted (unmount or a new send) and reports nothing after that", async () => {
    const ctrl = new AbortController();
    const onRows = vi.fn();
    const end = await watchUntilSettled({
      ids: ["a"],
      signal: ctrl.signal,
      sleep: instant,
      read: async () => {
        ctrl.abort();
        return [{ request_id: "a", status: "paid" }];
      },
      onRows,
    });
    expect(end).toBe("aborted");
    expect(onRows).not.toHaveBeenCalled();
  });

  it("a row the server does not return (not this visitor's) stops being watched", async () => {
    const end = await watchUntilSettled({ ids: ["a"], signal: new AbortController().signal, sleep: instant, read: async () => [], onRows: () => undefined });
    expect(end).toBe("settled");
  });

  it("waits the interval between reads with real timers", async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(async () => [{ request_id: "a", status: "paid" }]);
      const p = watchUntilSettled({ ids: ["a"], signal: new AbortController().signal, read, onRows: () => undefined });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(read).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await p).toBe("settled");
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GET /api/try/requests (visitor-scoped re-read)", () => {
  let ctx: Ctx;
  let prev: string | undefined;
  beforeEach(async () => {
    prev = process.env.REINS_TRY;
    process.env.REINS_TRY = "1";
    ctx = await createTestContext();
    // treasury: an approved request is "paying" until PayPal confirms the payout (hosted demo mode)
    await updateWorkspace(ctx.db, { paypalEnv: "fake", paymentMode: "treasury", connectedAt: Date.now() });
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.REINS_TRY;
    else process.env.REINS_TRY = prev;
  });

  it("paying -> paid: the visitor re-reads its own row and sees Paid with the receipt; the receipt has no recorded-run label", async () => {
    const handle = createRouter(async () => ctx);
    const sent = await runPlayground(ctx, preset("domain"), { visitor: VISITOR_A });
    expect(sent.row.status).toBe("paying");

    const first = await read(handle, [sent.row.request_id], VISITOR_A);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { rows: LedgerRow[] }).rows.map((r) => r.status)).toEqual(["paying"]);

    // PayPal confirms the payout (the sweep asks GET /v1/payments/payouts; the webhook path does the same)
    ctx.paypal.payoutItemStatus.set(sent.row.payment!.payout_batch_id!, "SUCCESS");
    await resolvePendingPayments(ctx, 0);

    const { rows } = (await (await read(handle, [sent.row.request_id], VISITOR_A)).json()) as { rows: LedgerRow[] };
    expect(rows[0]!.status).toBe("paid");
    expect(rows[0]!.receipt?.receipt_url).toMatch(/\/receipts\//);
    expect(rows[0]!.recorded).toBeNull();
    expect(recordedChip(rows[0]!.recorded)).toBeNull();
    expect((await getReceipt(ctx, sent.row.request_id)).recorded).toBeNull();
  });

  it("never returns another visitor's rows, rows without a cookie, or non-playground rows", async () => {
    const handle = createRouter(async () => ctx);
    const mine = await runPlayground(ctx, preset("domain"), { visitor: VISITOR_A });
    const theirs = await runPlayground(ctx, preset("domain"), { visitor: VISITOR_B });
    const both = [mine.row.request_id, theirs.row.request_id];

    const a = (await (await read(handle, both, VISITOR_A)).json()) as { rows: LedgerRow[] };
    expect(a.rows.map((r) => r.request_id)).toEqual([mine.row.request_id]);
    const none = (await (await read(handle, both)).json()) as { rows: LedgerRow[] };
    expect(none.rows).toEqual([]);
    const junk = (await (await read(handle, ["../../etc", "x".repeat(80)], VISITOR_A)).json()) as { rows: LedgerRow[] };
    expect(junk.rows).toEqual([]);
  });

  it("five orders in one call; at most 10 ids are read", async () => {
    const handle = createRouter(async () => ctx);
    const split = PRESETS.find((p) => p.id === "split")!;
    const ids: string[] = [];
    for (let i = 0; i < split.repeat!; i++) ids.push((await runPlayground(ctx, split.purchase, { visitor: VISITOR_A })).row.request_id);
    const { rows } = (await (await read(handle, ids, VISITOR_A)).json()) as { rows: LedgerRow[] };
    expect(rows.map((r) => r.status)).toEqual(["paying", "paying", "paying", "denied", "denied"]);
    const many = Array.from({ length: 12 }, () => ids[0]!).map((id, i) => (i < 11 ? `${id}${i}` : id));
    expect(((await (await read(handle, many, VISITOR_A)).json()) as { rows: LedgerRow[] }).rows).toEqual([]); // the real id is the 12th
  });

  it("needs no admin token, is per-IP rate limited, and is off when the playground is off", async () => {
    const limiter = new RateLimiter({ tryRead: { capacity: 2, refillPerMinute: 0.0001 } });
    const handle = createRouter(async () => ctx, { adminToken: "secret-admin", rateLimiter: limiter });
    const sent = await runPlayground(ctx, preset("domain"), { visitor: VISITOR_A });
    expect((await read(handle, [sent.row.request_id], VISITOR_A)).status).toBe(200);
    expect((await read(handle, [sent.row.request_id], VISITOR_A)).status).toBe(200);
    expect((await read(handle, [sent.row.request_id], VISITOR_A)).status).toBe(429);

    delete process.env.REINS_TRY;
    const prevDemo = process.env.REINS_PUBLIC_DEMO;
    delete process.env.REINS_PUBLIC_DEMO;
    try {
      expect((await read(createRouter(async () => ctx), [sent.row.request_id], VISITOR_A)).status).toBe(403);
    } finally {
      if (prevDemo !== undefined) process.env.REINS_PUBLIC_DEMO = prevDemo;
    }
  });
});

describe("keep-warm (REINS_KEEPWARM_URL)", () => {
  it("is disabled when the variable is unset, empty or not a URL: no timer, no fetch", () => {
    const fetch = vi.fn();
    const setInterval = vi.fn(() => ({}));
    for (const env of [{}, { REINS_KEEPWARM_URL: "" }, { REINS_KEEPWARM_URL: "  " }, { REINS_KEEPWARM_URL: "reins-mcp.onrender.com" }]) {
      expect(startKeepWarm(env, { fetch, setInterval })).toBeNull();
    }
    expect(setInterval).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("GETs the URL on every 10-minute tick and swallows a failure with one log line", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => new Response("ok"));
      const log = vi.fn();
      const tick = startKeepWarm({ REINS_KEEPWARM_URL: "https://reins-mcp.onrender.com/health" }, { fetch, log });
      expect(tick).not.toBeNull();
      expect(fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(KEEPWARM_INTERVAL_MS);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect((fetch.mock.calls[0] as unknown[])[0]).toBe("https://reins-mcp.onrender.com/health");
      await vi.advanceTimersByTimeAsync(KEEPWARM_INTERVAL_MS);
      expect(fetch).toHaveBeenCalledTimes(2);

      fetch.mockRejectedValueOnce(new Error("ECONNRESET"));
      await expect(tick!()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]![0])).toContain("keep-warm");
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });
});
