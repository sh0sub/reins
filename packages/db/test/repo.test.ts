import { beforeEach, describe, expect, it } from "vitest";
import {
  countRequestsSince,
  createMandateVersion,
  createTestDb,
  findAgentByKeyHash,
  getActiveMandate,
  getWorkspace,
  insertAgent,
  insertRequest,
  listMandateVersions,
  recordWebhookEvent,
  markWebhookProcessed,
  spendSinceCents,
  transitionRequest,
  updateWorkspace,
  type ReinsDb,
} from "../src/index.ts";

const mandateInput = {
  monthlyLimitCents: 15000,
  autoApproveLimitCents: 3000,
  perTxCapCents: null,
  allowedMerchants: ["namecheap.com"],
  blockedMerchants: [],
  categories: ["domains"],
  purpose: "Keep dev infrastructure running",
  validFrom: null,
  validUntil: null,
};

describe("db repo", () => {
  let db: ReinsDb;
  let agentId: string;
  beforeEach(async () => {
    db = await createTestDb();
    agentId = (await insertAgent(db, { name: "DevOps", keyHash: "h1", keyPrefix: "rk_live_ab" })).id;
  });

  it("creates the singleton workspace lazily and updates it", async () => {
    expect((await getWorkspace(db)).paymentMode).toBe("supervised");
    expect((await updateWorkspace(db, { paymentMode: "vaulted" })).paymentMode).toBe("vaulted");
  });

  it("finds agents by key hash", async () => {
    expect((await findAgentByKeyHash(db, "h1"))?.id).toBe(agentId);
    expect(await findAgentByKeyHash(db, "nope")).toBeUndefined();
  });

  it("versions mandates and returns the latest as active", async () => {
    await createMandateVersion(db, agentId, mandateInput);
    await createMandateVersion(db, agentId, { ...mandateInput, monthlyLimitCents: 20000 });
    const v3 = await createMandateVersion(db, agentId, { ...mandateInput, perTxCapCents: 6000 });
    expect(v3.version).toBe(3);
    expect((await getActiveMandate(db, agentId))?.id).toBe(v3.id);
    expect((await listMandateVersions(db, agentId)).map((m) => m.version)).toEqual([3, 2, 1]);
    expect(v3.allowedMerchants).toEqual(["namecheap.com"]);
  });

  it("enforces the idempotency key (agent + client_request_id)", async () => {
    const base = { agentId, mandateId: null, merchant: "namecheap.com", amountCents: 1298, currency: "USD", items: "domain", reason: "renew", category: null };
    const a = await insertRequest(db, { ...base, clientRequestId: "c1" });
    const b = await insertRequest(db, { ...base, clientRequestId: "c1" });
    const c = await insertRequest(db, { ...base, clientRequestId: "c2" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.request.id).toBe(a.request.id);
    expect(c.request.seq).toBe(a.request.seq + 1);
  });

  it("transitions status atomically (only one winner)", async () => {
    const { request } = await insertRequest(db, { agentId, mandateId: null, clientRequestId: "x", merchant: "m.com", amountCents: 100, currency: "USD", items: "i", reason: "r", category: null });
    await transitionRequest(db, request.id, ["reviewing"], { status: "pending_human" });
    const first = await transitionRequest(db, request.id, ["pending_human"], { status: "approved" });
    const second = await transitionRequest(db, request.id, ["pending_human"], { status: "denied" });
    expect(first?.status).toBe("approved");
    expect(second).toBeUndefined();
  });

  it("counts velocity and committed spend", async () => {
    const now = Date.now();
    const mk = (id: string, cents: number, at: number) =>
      insertRequest(db, { agentId, mandateId: null, clientRequestId: id, merchant: "m.com", amountCents: cents, currency: "USD", items: "i", reason: "r", category: null, createdAt: at });
    const r1 = await mk("a", 1000, now - 60_000);
    await mk("b", 2000, now - 20 * 60_000);
    const r3 = await mk("c", 500, now);
    await transitionRequest(db, r1.request.id, ["reviewing"], { status: "paid" });
    expect(await countRequestsSince(db, agentId, now - 10 * 60_000)).toBe(2);
    expect(await countRequestsSince(db, agentId, now - 10 * 60_000, r3.request.id)).toBe(1);
    expect(await spendSinceCents(db, agentId, now - 3600_000)).toBe(1000);
  });

  it("dedupes webhook event ids", async () => {
    expect(await recordWebhookEvent(db, { id: "WH-1", eventType: "X" })).toBe("new");
    expect(await recordWebhookEvent(db, { id: "WH-1", eventType: "X" })).toBe("retry");
    await markWebhookProcessed(db, "WH-1", "ok");
    expect(await recordWebhookEvent(db, { id: "WH-1", eventType: "X" })).toBe("duplicate");
  });
});
