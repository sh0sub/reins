import { randomBytes } from "node:crypto";
import { PLAYGROUND_SCOPE_PREFIX, type ReinsDb } from "@reins/db";
import { generateApiKey, hashApiKey } from "./keys.ts";

/**
 * Per-visitor demo keys for "Connect your own agent" (/api/try/connect). Every visitor gets an own key for the shared
 * Playground Agent, bound to an own playground scope ("try:mcp<hex>:"). Requests made with it only count against that
 * visitor's spend, split-purchase and velocity windows, so one judge's MCP calls never block another's, while the
 * velocity rule itself (3 per 10 min) stays fully in force inside one visitor.
 *
 * In server memory only (the public demo is one process whose database also lives in /tmp): a restart forgets the keys,
 * and the page simply hands out a new one. Only the hash is used for lookup; the plaintext is kept so the same visitor
 * (cookie) gets the same key back while it lives.
 */
export const DEMO_KEY_PREFIX = "rk_demo_";
export const DEMO_KEY_TTL_MS = 24 * 3_600_000;
/** Upper bound on live keys per database, so a flood of connects cannot grow memory without limit. */
export const DEMO_KEY_MAX = 5_000;

export interface DemoKey {
  key: string;
  hash: string;
  agentId: string;
  /** Playground scope ("try:mcp<hex>:") applied to every request made with this key. */
  scope: string;
  visitor: string;
  expiresAt: number;
}

interface Registry {
  byHash: Map<string, DemoKey>;
  byVisitor: Map<string, DemoKey>;
}
const registries = new WeakMap<ReinsDb, Registry>();

function registry(db: ReinsDb): Registry {
  let r = registries.get(db);
  if (!r) registries.set(db, (r = { byHash: new Map(), byVisitor: new Map() }));
  return r;
}

function drop(r: Registry, k: DemoKey) {
  r.byHash.delete(k.hash);
  if (r.byVisitor.get(k.visitor) === k) r.byVisitor.delete(k.visitor);
}

/** The live key of this visitor, or a fresh one (new random scope, 24 h lifetime) for the given Playground Agent. */
export function issueDemoKey(db: ReinsDb, agentId: string, visitor: string, now: number): DemoKey {
  const r = registry(db);
  const live = r.byVisitor.get(visitor);
  if (live && live.expiresAt > now && live.agentId === agentId) return live;
  if (live) drop(r, live);
  for (const k of r.byHash.values()) if (k.expiresAt <= now) drop(r, k);
  // Map keeps insertion order: the first entries are the oldest keys
  while (r.byHash.size >= DEMO_KEY_MAX) drop(r, r.byHash.values().next().value as DemoKey);
  const { key, hash } = generateApiKey(DEMO_KEY_PREFIX);
  const entry: DemoKey = { key, hash, agentId, scope: `${PLAYGROUND_SCOPE_PREFIX}mcp${randomBytes(12).toString("hex")}:`, visitor, expiresAt: now + DEMO_KEY_TTL_MS };
  r.byHash.set(hash, entry);
  r.byVisitor.set(visitor, entry);
  return entry;
}

/** "live" with the entry, "expired" for a known key past its lifetime, null when the key is not a demo key. */
export function lookupDemoKey(db: ReinsDb, key: string, now: number): { state: "live"; entry: DemoKey } | { state: "expired" } | null {
  if (!key.startsWith(DEMO_KEY_PREFIX)) return null;
  const r = registry(db);
  const entry = r.byHash.get(hashApiKey(key));
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    drop(r, entry);
    return { state: "expired" };
  }
  return { state: "live", entry };
}

/** Forgets every demo key of these agents (playground reset). */
export function revokeDemoKeys(db: ReinsDb, agentIds: string[]) {
  const r = registry(db);
  for (const k of [...r.byHash.values()]) if (agentIds.includes(k.agentId)) drop(r, k);
}
