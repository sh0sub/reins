/**
 * Shared in-process harness for the Should-feature tests (S3-S6): router + MCP client over an in-memory transport,
 * fake PayPal, mock auditor, controllable clock. Same wiring as flow.test.ts.
 */
import { expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { updateWorkspace } from "@reins/db";
import { createTestContext } from "@reins/core/testing";
import { ReinsApi, createReinsMcpServer } from "@reins/mcp";
import { createRouter } from "../../apps/web/src/server/router.ts";

export const BASE = "http://reins.test";
const MIN = 60_000;

export async function harness(opts: { overrides?: Parameters<typeof createTestContext>[0]; adminToken?: string; start?: number } = {}) {
  let clock = opts.start ?? Date.now();
  const ctx = await createTestContext({ now: () => clock, ...opts.overrides, config: { approvalTtlMs: 365 * 24 * 60 * MIN, ...opts.overrides?.config } });
  const handle = createRouter(async () => ctx, { adminToken: opts.adminToken });
  const fetchViaRouter = (url: string, init?: RequestInit) => handle(new Request(url, init));
  const admin = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handle(new Request(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  /** Moves the clock forward (keeps the 3-per-10-minutes velocity rule out of the way). */
  const tick = (minutes = 11) => {
    clock += minutes * MIN;
    return clock;
  };
  const vaulted = () => updateWorkspace(ctx.db, { paymentMode: "vaulted", vaultId: "VAULT-TEST" });

  async function agentClient(name: string, mandate: Record<string, unknown>) {
    const created = await admin("POST", "/api/agents", { name, mandate }, opts.adminToken ? { "x-reins-admin": opts.adminToken } : {});
    expect(created.status).toBe(201);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createReinsMcpServer(new ReinsApi(BASE, created.body.api_key, fetchViaRouter)).connect(a);
    const client = new Client({ name: "agent-sim", version: "0" });
    await client.connect(b);
    const call = async (tool: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name: tool, arguments: args });
      return { text: (r.content as Array<{ text: string }>)[0]!.text, data: r.structuredContent as Record<string, any>, isError: r.isError as boolean | undefined };
    };
    return { call, agentId: created.body.agent.id as string, apiKey: created.body.api_key as string };
  }
  return { ctx, admin, agentClient, tick, vaulted, now: () => clock };
}

export const scoutMandate = {
  monthly_limit: "200.00",
  auto_approve_limit: "25.00",
  per_purchase_cap: "100.00",
  allowed_merchants: ["statista.com", "gartner.com"],
  blocked_merchants: ["fiverr.com"],
  categories: ["research"],
  purpose: "Buy market research reports for product research",
};
export const devopsMandate = {
  monthly_limit: "150.00",
  auto_approve_limit: "30.00",
  per_purchase_cap: "100.00",
  allowed_merchants: ["namecheap.com", "vercel.com", "render.com", "anthropic.com"],
  blocked_merchants: ["fiverr.com"],
  categories: ["domains", "hosting", "api-credits"],
  purpose: "Keep developer infrastructure running: domain renewals, hosting and API credits",
};
export const report = (n = 1, amount = "59.00", merchant = "statista.com") => ({
  merchant,
  amount,
  items: `Market research report #${n}`,
  reason: "Market research report for the product research memo",
  category: "research",
  client_request_id: `report-${merchant}-${n}-${amount}`,
});
