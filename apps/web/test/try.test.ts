import { beforeEach, describe, expect, it } from "vitest";
import { updateWorkspace } from "@reins/db";
import { createTestContext } from "@reins/core/testing";
import { getOverview, resetPlayground, runPlayground } from "@reins/core";
import { usd, usdAmount } from "../src/lib/format.ts";
import { PROOF_ITEMS, proofLogUrl } from "../src/app/proof/proof.ts";
import { createRouter } from "../src/server/router.ts";
import { PRESETS } from "../src/app/try/presets.ts";

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
const post = (handle: (r: Request) => Promise<Response>, body: unknown) =>
  handle(new Request("http://localhost/api/try", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const preset = (id: string) => PRESETS.find((p) => p.id === id)!.purchase;

describe("/try playground", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await createTestContext();
    await updateWorkspace(ctx.db, { paypalEnv: "fake", paymentMode: "vaulted", vaultId: "VAULT-FAKE-TEST", connectedAt: Date.now() });
  });

  it("$12.98 namecheap is paid, $59 statista waits for a person, $450 fiverr is denied by three hard rules", async () => {
    const paid = await runPlayground(ctx, preset("domain"));
    expect(paid.row.status).toBe("paid");
    expect(paid.paypal).toBe("simulated");
    expect(paid.row.payment?.capture_id).toMatch(/^SIM-/);

    const pending = await runPlayground(ctx, preset("report"));
    expect(pending.row.status).toBe("pending_human");

    const denied = await runPlayground(ctx, preset("injection"));
    expect(denied.row.status).toBe("denied");
    expect(denied.failed_rules.sort()).toEqual(["allowlist", "monthly_limit", "per_tx_cap"]);
    expect(denied.row.payment).toBeNull();
    expect(ctx.paypal.calls.filter((c) => c === "createOrder")).toHaveLength(1);
  });

  it("the split preset: five $29 orders to vercel.com, three are paid and the rest are denied by the same-merchant rule", async () => {
    const split = PRESETS.find((p) => p.id === "split")!;
    expect(split.repeat).toBe(5);
    // after the tour's two presets, so earlier requests (other merchants) cannot change the outcome
    await runPlayground(ctx, preset("domain"));
    await runPlayground(ctx, preset("report"));
    const out = [];
    for (let i = 0; i < split.repeat!; i++) out.push(await runPlayground(ctx, split.purchase));
    expect(out.map((r) => r.row.status)).toEqual(["paid", "paid", "paid", "denied", "denied"]);
    expect(out[3]!.failed_rules).toEqual(["merchant_total"]);
    expect(ctx.paypal.calls.filter((c) => c === "createOrder")).toHaveLength(4); // the $12.98 domain + three $29 orders; no money for the denied two
  });

  it("a fooled auditor that always says AUTO_APPROVE cannot get the $450 order or the $59 order paid", async () => {
    const denied = await runPlayground(ctx, preset("injection"), { fooled: true });
    expect(denied.auditor).toBe("fooled");
    expect(denied.row.decisions.find((d) => d.stage === "llm")).toMatchObject({ actor: "fooled", risk: 1 });
    expect(denied.row.status).toBe("denied");
    expect(ctx.paypal.calls).not.toContain("createOrder");

    const over = await runPlayground(ctx, preset("report"), { fooled: true });
    expect(over.row.status).toBe("pending_human"); // above the auto-approve limit, so code still asks a person
    expect(ctx.paypal.calls).not.toContain("createOrder");
  });

  it("relaxes only the velocity rule, so the presets can be clicked repeatedly", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await runPlayground(ctx, { ...preset("domain"), client_request_id: `c-${i}` });
      expect(r.failed_rules).not.toContain("velocity");
      expect(r.row.status).not.toBe("denied");
    }
  });

  it("is a real agent in the ledger, but the overview leaves it out unless asked", async () => {
    await runPlayground(ctx, preset("injection"));
    const hidden = await getOverview(ctx);
    expect(hidden.protection).toMatchObject({ blocked_cents: 0, blocked_count: 0, requests: 0 });
    expect(hidden.agents.map((a) => a.name)).not.toContain("Playground Agent");
    expect(hidden.playground).toEqual({ included: false, requests: 1 });
    const o = await getOverview(ctx, "month", { includePlayground: true });
    expect(o.protection).toMatchObject({ blocked_cents: 45000, blocked_count: 1, exposure_cents: 30000 });
    expect(o.playground.included).toBe(true);
  });

  it("reset removes only the playground agent and its requests, and the playground works again afterwards", async () => {
    await runPlayground(ctx, preset("domain"));
    await runPlayground(ctx, preset("report"));
    expect((await getOverview(ctx, "month", { includePlayground: true })).decisions.total).toBe(2);
    expect(await resetPlayground(ctx)).toEqual({ removed_requests: 2 });
    expect((await getOverview(ctx, "month", { includePlayground: true })).decisions.total).toBe(0);
    expect(await resetPlayground(ctx)).toEqual({ removed_requests: 0 });
    const again = await runPlayground(ctx, preset("domain"));
    expect(again.row.status).toBe("paid");
  });

  it("REST: reset and include_playground follow judge mode", async () => {
    const handle = createRouter(async () => ctx);
    const prev = { try: process.env.REINS_TRY, demo: process.env.REINS_PUBLIC_DEMO };
    const reset = () => handle(new Request("http://localhost/api/try/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    try {
      delete process.env.REINS_TRY;
      process.env.REINS_PUBLIC_DEMO = "1";
      expect((await reset()).status).toBe(403); // the public demo never offers a reset
      process.env.REINS_TRY = "1";
      await runPlayground(ctx, preset("domain"));
      const ov = async (q: string) => ((await (await handle(new Request(`http://localhost/api/overview${q}`))).json()) as { decisions: { total: number } }).decisions.total;
      expect(await ov("")).toBe(0);
      expect(await ov("?include_playground=1")).toBe(1);
      const res = await reset();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ removed_requests: 1 });
    } finally {
      if (prev.try === undefined) delete process.env.REINS_TRY;
      else process.env.REINS_TRY = prev.try;
      if (prev.demo === undefined) delete process.env.REINS_PUBLIC_DEMO;
      else process.env.REINS_PUBLIC_DEMO = prev.demo;
    }
  });

  it("money formatting has a thousands separator", () => {
    expect(usd(135000)).toBe("$1,350.00");
    expect(usd(1298)).toBe("$12.98");
    expect(usdAmount(1350)).toBe("$1,350.00");
  });

  it("proof page data carries the real sandbox ids from the spike logs", () => {
    const ids = PROOF_ITEMS.flatMap((p) => p.ids.map((i) => i.value));
    for (const id of ["04X61877K0529583E", "03A015968J4767410", "880199579M655730R", "UALE8USQRMHYW"]) expect(ids).toContain(id);
    expect(PROOF_ITEMS.some((p) => p.status.includes("401"))).toBe(true);
    for (const p of PROOF_ITEMS) expect(proofLogUrl(p.log)).toMatch(/\/docs\/spikes\/.+\.md$/);
  });

  it("REST: off unless REINS_TRY=1 or the public demo", async () => {
    const handle = createRouter(async () => ctx);
    const prev = { try: process.env.REINS_TRY, demo: process.env.REINS_PUBLIC_DEMO };
    try {
      delete process.env.REINS_TRY;
      delete process.env.REINS_PUBLIC_DEMO;
      const off = await post(handle, preset("domain"));
      expect(off.status).toBe(403);
      expect(((await off.json()) as { error: string }).error).toBe("try_disabled");
      process.env.REINS_TRY = "1";
      const on = await post(handle, { ...preset("injection"), fooled_auditor: true });
      expect(on.status).toBe(201);
      const body = (await on.json()) as { row: { status: string }; auditor: string };
      expect(body).toMatchObject({ auditor: "fooled", row: { status: "denied" } });
    } finally {
      if (prev.try === undefined) delete process.env.REINS_TRY;
      else process.env.REINS_TRY = prev.try;
      if (prev.demo === undefined) delete process.env.REINS_PUBLIC_DEMO;
      else process.env.REINS_PUBLIC_DEMO = prev.demo;
    }
  });

  it("connect card: the demo key is only served on a demo instance and it really authenticates request_purchase", async () => {
    const handle = createRouter(async () => ctx);
    const get = () => handle(new Request("http://localhost/api/try/connect"));
    const prev = { try: process.env.REINS_TRY, demo: process.env.REINS_PUBLIC_DEMO };
    try {
      delete process.env.REINS_TRY;
      delete process.env.REINS_PUBLIC_DEMO;
      expect((await get()).status).toBe(403);
      process.env.REINS_TRY = "1";
      const res = await get();
      expect(res.status).toBe(200);
      const c = (await res.json()) as { api_key: string; mcp_config: { mcpServers: { reins: { env: { REINS_API_KEY: string } } } } };
      expect(c.api_key).toMatch(/^rk_live_/);
      expect(c.mcp_config.mcpServers.reins.env.REINS_API_KEY).toBe(c.api_key);
      const paid = await handle(
        new Request("http://localhost/api/requests", { method: "POST", headers: { authorization: `Bearer ${c.api_key}`, "content-type": "application/json" }, body: JSON.stringify(preset("domain")) }),
      );
      expect(paid.status).toBe(201);
      expect(((await paid.json()) as { status: string }).status).toBe("paid");
    } finally {
      if (prev.try === undefined) delete process.env.REINS_TRY;
      else process.env.REINS_TRY = prev.try;
      if (prev.demo === undefined) delete process.env.REINS_PUBLIC_DEMO;
      else process.env.REINS_PUBLIC_DEMO = prev.demo;
    }
  });
});
