import {
  clearRequestAnomalies,
  getAgent,
  getRequest,
  insertAgentEvent,
  listAgentEvents,
  listRequests,
  replaceAgentKey,
  setAgentPaused,
  type Agent,
  type AgentEvent,
} from "@reins/db";
import { generateApiKey } from "./keys.ts";
import { merchantInList } from "./merchant.ts";
import { ReinsError, mcpSnippet, type ReinsContext } from "./service.ts";
import { displayId } from "./pay/strategies.ts";

/**
 * S2/S3/S6 agent controls: pause/resume, key regeneration and "Mark as expected". Every action writes an
 * agent_events row (actor + short note, never a key or hash).
 */

export type AgentStatus = "active" | "paused" | "revoked";

export function agentStatus(a: Pick<Agent, "revokedAt" | "pausedAt">): AgentStatus {
  if (a.revokedAt != null) return "revoked";
  return a.pausedAt != null ? "paused" : "active";
}

async function requireAgent(ctx: ReinsContext, agentId: string): Promise<Agent> {
  const agent = await getAgent(ctx.db, agentId);
  if (!agent) throw new ReinsError(404, "not_found", "Agent not found");
  return agent;
}

export interface AgentStatusResult {
  agent: { id: string; name: string; status: AgentStatus; paused_at: string | null };
  /** false when the agent already was in the requested state (idempotent second tap). */
  changed: boolean;
}

function statusResult(a: Agent, changed: boolean): AgentStatusResult {
  return { agent: { id: a.id, name: a.name, status: agentStatus(a), paused_at: a.pausedAt == null ? null : new Date(a.pausedAt).toISOString() }, changed };
}

/** Pauses an agent: its new requests are denied by the "agent paused" hard rule (no auditor, no PayPal). Idempotent. */
export async function pauseAgent(ctx: ReinsContext, agentId: string, actor: string, detail?: string): Promise<AgentStatusResult> {
  const agent = await requireAgent(ctx, agentId);
  if (agent.revokedAt != null) throw new ReinsError(409, "revoked", "This agent's key is revoked");
  if (agent.pausedAt != null) return statusResult(agent, false);
  const at = ctx.now();
  const updated = (await setAgentPaused(ctx.db, agentId, at))!;
  await insertAgentEvent(ctx.db, { agentId, type: "paused", actor, detail: detail ?? null, createdAt: at });
  return statusResult(updated, true);
}

export async function resumeAgent(ctx: ReinsContext, agentId: string, actor: string): Promise<AgentStatusResult> {
  const agent = await requireAgent(ctx, agentId);
  if (agent.pausedAt == null) return statusResult(agent, false);
  const updated = (await setAgentPaused(ctx.db, agentId, null))!;
  await insertAgentEvent(ctx.db, { agentId, type: "resumed", actor, createdAt: ctx.now() });
  return statusResult(updated, true);
}

/** Telegram "Pause this agent" / S6 drawer: pauses the agent that made this request. */
export async function pauseAgentForRequest(ctx: ReinsContext, requestId: string, actor: string): Promise<AgentStatusResult> {
  const r = await getRequest(ctx.db, requestId);
  if (!r) throw new ReinsError(404, "not_found", "Request not found");
  return pauseAgent(ctx, r.agentId, actor, `from ${displayId(r.seq)}`);
}

/**
 * Regenerates an agent's key. The stored hash is replaced in one UPDATE, so the old key fails with 401 from the
 * next request on; the new key is returned once (same pattern as createAgent) and only its hash is stored.
 */
export async function rotateAgentKey(ctx: ReinsContext, agentId: string, actor: string) {
  const agent = await requireAgent(ctx, agentId);
  if (agent.revokedAt != null) throw new ReinsError(409, "revoked", "This agent's key is revoked");
  const { key, hash, displayPrefix } = generateApiKey();
  const at = ctx.now();
  const updated = await replaceAgentKey(ctx.db, agentId, { keyHash: hash, keyPrefix: displayPrefix, at });
  if (!updated) throw new ReinsError(409, "revoked", "This agent's key is revoked");
  await insertAgentEvent(ctx.db, { agentId, type: "key_rotated", actor, detail: `old ${agent.keyPrefix}… → new ${displayPrefix}…`, createdAt: at });
  return {
    agent: { id: updated.id, name: updated.name, key_prefix: updated.keyPrefix, key_rotated_at: new Date(at).toISOString() },
    api_key: key,
    mcp_snippet: mcpSnippet(ctx.config.apiBaseUrl ?? ctx.config.publicBaseUrl, key),
  };
}

/**
 * S6 "Mark as expected": the owner says this merchant pattern is normal for this agent. Clears the S3 unusual-pattern
 * flags on every request from this agent to this merchant (status, risk and decisions stay as they were) and logs it.
 */
export async function markPatternExpected(ctx: ReinsContext, requestId: string, actor: string): Promise<{ merchant: string; cleared: number }> {
  const r = await getRequest(ctx.db, requestId);
  if (!r) throw new ReinsError(404, "not_found", "Request not found");
  const same = (await listRequests(ctx.db, { agentId: r.agentId, limit: 500 })).filter((x) => merchantInList(x.merchant, [r.merchant]) && (x.anomalies ?? []).length > 0);
  const cleared = await clearRequestAnomalies(ctx.db, same.map((x) => x.id));
  await insertAgentEvent(ctx.db, { agentId: r.agentId, type: "pattern_expected", actor, detail: `${r.merchant} from ${displayId(r.seq)} · ${cleared} flagged request(s) cleared`, createdAt: ctx.now() });
  return { merchant: r.merchant, cleared };
}

export function agentEventView(e: AgentEvent) {
  return { type: e.type, actor: e.actor, detail: e.detail, created_at: new Date(e.createdAt).toISOString() };
}

export async function getAgentEvents(ctx: ReinsContext, agentId: string) {
  await requireAgent(ctx, agentId);
  return (await listAgentEvents(ctx.db, agentId)).map(agentEventView);
}
