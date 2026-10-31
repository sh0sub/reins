/**
 * #36 D9 (SSE heartbeat/reconnect contract), #10 M10 (Ask agent, inbox budget, deny note), #11 M11 (reconcile route).
 */
import { describe, expect, it } from "vitest";
import { updateWorkspace } from "@reins/db";
import { createTestContext } from "@reins/core/testing";
import { createRouter } from "../src/server/router.ts";
import { LiveConnection, type EventSourceLike, type LiveEvent } from "../src/lib/live.ts";

const BASE = "http://localhost:3000";
const mandate = { monthly_limit: "60.00", auto_approve_limit: "25.00", per_purchase_cap: "100.00", blocked_merchants: ["fiverr.com"], categories: ["research"], purpose: "Buy market research reports" };

async function setup(opts: { sseHeartbeatMs?: number; cronSecret?: string } = {}) {
  const ctx = await createTestContext();
  const handle = createRouter(async () => ctx, opts);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handle(new Request(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const agent = (await call("POST", "/api/agents", { name: "Research Scout", mandate })).body;
  const auth = { authorization: `Bearer ${agent.api_key}` };
  return { ctx, handle, call, agent, auth };
}

const report = { merchant: "statista.com", amount: "59.00", items: "Market report", reason: "User asked for a market research report", category: "research" };

describe("#36 SSE stream", () => {
  it("sends ready (with heartbeat_ms + retry), named ping heartbeats, ids, and unsubscribes on abort", async () => {
    const { ctx, handle, call, auth } = await setup({ sseHeartbeatMs: 30 });
    const ac = new AbortController();
    const res = await handle(new Request(`${BASE}/api/events`, { signal: ac.signal }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const until = async (pred: (s: string) => boolean) => {
      while (!pred(buf)) buf += dec.decode((await reader.read()).value);
    };
    await until((s) => s.includes("event: ready"));
    expect(buf).toMatch(/^retry: 3000\nevent: ready\nid: 0\ndata: \{"heartbeat_ms":30\}/);
    expect(ctx.events.size).toBe(1);
    await until((s) => s.includes("event: ping"));
    await call("POST", "/api/requests", report, auth);
    await until((s) => s.includes("event: request.updated"));
    expect(buf).toMatch(/event: request\.created\nid: 1\ndata: \{/);
    ac.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(ctx.events.size).toBe(0);
  });
});

class FakeSource implements EventSourceLike {
  static all: FakeSource[] = [];
  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  closed = false;
  constructor() {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent);
  }
  close() {
    this.closed = true;
  }
}

describe("#36 client live connection (lib/live.ts)", () => {
  it("one shared socket, resync on ready, reconnect with backoff after an error, watchdog on silence", async () => {
    FakeSource.all = [];
    let now = 0;
    const live = new LiveConnection({ createSource: () => new FakeSource(), now: () => now });
    const seen: LiveEvent["type"][] = [];
    const off1 = live.subscribe((e) => seen.push(e.type));
    const off2 = live.subscribe(() => undefined);
    expect(FakeSource.all).toHaveLength(1); // shared
    expect(live.status).toBe("connecting");
    FakeSource.all[0]!.fire("ready", { heartbeat_ms: 1000 });
    expect(live.status).toBe("live");
    FakeSource.all[0]!.fire("request.updated", { request_id: "r1", display_id: "R-0001", status: "paid" });
    expect(seen).toEqual(["resync", "request.updated"]);

    FakeSource.all[0]!.onerror!(new Event("error"));
    expect(FakeSource.all[0]!.closed).toBe(true);
    expect(live.status).toBe("reconnecting");
    await new Promise((r) => setTimeout(r, 1100)); // first backoff = 1 s
    expect(FakeSource.all).toHaveLength(2);
    FakeSource.all[1]!.fire("ready", { heartbeat_ms: 1000 });
    expect(seen.filter((t) => t === "resync")).toHaveLength(2); // refetch after reconnect

    now += 3000; // > 2.5 x heartbeat without a ping
    live.restart(); // what the 5 s watchdog does; called directly to keep the test fast
    expect(FakeSource.all[1]!.closed).toBe(true);
    off1();
    off2();
    expect(live.status).toBe("offline");
  });
});

describe("#10 web inbox: Ask agent, budget, deny note", () => {
  it("question -> waiting state -> agent answers via REST (MCP path) -> card shows answer; one open question at a time", async () => {
    const { call, auth } = await setup();
    const r = (await call("POST", "/api/requests", report, auth)).body;
    expect(r.status).toBe("pending_human");

    const inbox = (await call("GET", "/api/inbox")).body.items;
    expect(inbox[0].budget).toEqual({ month_spent_cents: 0, monthly_limit_cents: 6000, auto_approve_limit_cents: 2500 });
    expect(inbox[0].agent_reason).toBe(report.reason);

    const asked = await call("POST", `/api/requests/${r.request_id}/ask`, { question: "Is this the 2026 edition?" });
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({ needs_clarification: true, clarification: { question: "Is this the 2026 edition?", answer: null } });
    expect((await call("POST", `/api/requests/${r.request_id}/ask`, { question: "again?" })).body.error).toBe("question_open");
    expect((await call("POST", `/api/requests/${r.request_id}/ask`, { question: "" })).status).toBe(400);

    const agentView = (await call("GET", `/api/requests/${r.request_id}`, undefined, auth)).body;
    expect(agentView.needs_clarification).toBe(true);
    const answered = await call("POST", `/api/requests/${r.request_id}/answer`, { answer: "Yes, published Oct 2026." }, auth);
    expect(answered.body).toMatchObject({ status: "pending_human", needs_clarification: false, clarification: { answer: "Yes, published Oct 2026." } });
    expect((await call("POST", `/api/requests/${r.request_id}/answer`, { answer: "twice" }, auth)).body.error).toBe("no_question");

    const row = (await call("GET", `/api/ledger/${r.request_id}`)).body;
    expect(row.messages.map((m: { role: string }) => m.role)).toEqual(["human", "agent"]);
  });

  it("another agent cannot answer; decided requests cannot be asked", async () => {
    const { call, auth } = await setup();
    const other = (await call("POST", "/api/agents", { name: "Other", mandate })).body;
    const r = (await call("POST", "/api/requests", report, auth)).body;
    await call("POST", `/api/requests/${r.request_id}/ask`, { question: "Why?" });
    expect((await call("POST", `/api/requests/${r.request_id}/answer`, { answer: "x" }, { authorization: `Bearer ${other.api_key}` })).status).toBe(404);
    await call("POST", `/api/requests/${r.request_id}/decision`, { action: "deny", note: "Too expensive" });
    expect((await call("POST", `/api/requests/${r.request_id}/ask`, { question: "late" })).body.error).toBe("already_decided");
    const row = (await call("GET", `/api/ledger/${r.request_id}`)).body;
    expect(row.reason).toMatch(/^Denied by web: Too expensive\./);
    expect((await call("GET", "/api/inbox")).body.items).toEqual([]); // inbox empties after the decision
  });
});

describe("#11 reconcile route", () => {
  it("marks a vault capture matched via Transaction Search and reports counts", async () => {
    const { ctx, call, auth } = await setup();
    await updateWorkspace(ctx.db, { paymentMode: "vaulted", vaultId: "VAULT-1" });
    const r = (await call("POST", "/api/requests", { ...report, amount: "12.00" }, auth)).body;
    expect(r.status).toBe("paid");
    const rec = await call("POST", "/api/reconcile", { days: 2 });
    expect(rec.body).toMatchObject({ checked: 1, matched: 1, mismatch: 0, pending: 0 });
    expect((await call("GET", `/api/ledger/${r.request_id}`)).body.payment.reconciled).toBe("matched");
  });
  it("Transaction Search outage -> 502 with a readable message", async () => {
    const { ctx, call } = await setup();
    ctx.paypal.failNextSearch = Object.assign(new Error("PayPal 429"), { status: 429 });
    const rec = await call("POST", "/api/reconcile", {});
    expect(rec.status).toBe(502);
    expect(rec.body.message).toBe("Couldn't sync with PayPal Transaction Search (HTTP 429). Showing cached data.");
  });
});

describe("#38 cron reconcile route (Render Cron can't share the web disk)", () => {
  it("needs REINS_CRON_SECRET even in open demo mode; the right secret runs the same reconcile", async () => {
    const { ctx, call, auth } = await setup({ cronSecret: "cron-s3cret" });
    await updateWorkspace(ctx.db, { paymentMode: "vaulted", vaultId: "VAULT-1" });
    await call("POST", "/api/requests", { ...report, amount: "12.00" }, auth);
    expect((await call("POST", "/api/cron/reconcile", {})).status).toBe(401);
    expect((await call("POST", "/api/cron/reconcile", {}, { authorization: "Bearer wrong" })).status).toBe(401);
    const rec = await call("POST", "/api/cron/reconcile", { days: 2 }, { authorization: "Bearer cron-s3cret" });
    expect(rec.status).toBe(200);
    expect(rec.body).toMatchObject({ checked: 1, matched: 1, mismatch: 0 });
  });
  it("is disabled (503) when no secret is configured, and the admin token does not open it", async () => {
    const ctx = await createTestContext();
    const handle = createRouter(async () => ctx, { adminToken: "admin-tok" });
    const res = await handle(new Request(`${BASE}/api/cron/reconcile`, { method: "POST", headers: { authorization: "Bearer admin-tok" } }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("cron_disabled");
  });
});

describe("POST /api/paypal/connect on the public demo", () => {
  it("refuses custom credentials but still connects the demo merchant", async () => {
    process.env.REINS_PUBLIC_DEMO = "1";
    try {
      const ctx = await createTestContext();
      const handle = createRouter(async () => ctx, {});
      const post = (body: unknown) => handle(new Request(`${BASE}/api/paypal/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      const custom = await post({ client_id: "x", client_secret: "y" });
      expect(custom.status).toBe(403);
      expect((await custom.json()).error).toBe("demo_only");
      expect((await post({ demo: true })).status).toBe(200);
    } finally {
      delete process.env.REINS_PUBLIC_DEMO;
    }
  });
});

describe("POST /api/demo/request on the public demo", () => {
  it("is refused outside the public demo", async () => {
    const { call } = await setup();
    const res = await call("POST", "/api/demo/request", {});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("demo_only");
  });

  it("raises the Research Scout statista request into the inbox", async () => {
    process.env.REINS_PUBLIC_DEMO = "1";
    try {
      const { call } = await setup();
      const res = await call("POST", "/api/demo/request", {});
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("pending_human");
      const inbox = (await call("GET", "/api/inbox")).body.items;
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toMatchObject({ agent_name: "Research Scout", merchant: "statista.com", amount: "59.00" });
    } finally {
      delete process.env.REINS_PUBLIC_DEMO;
    }
  });
});
