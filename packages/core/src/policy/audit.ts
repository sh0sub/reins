import { z } from "zod";
import type { Mandate, PurchaseRequest } from "@reins/db";
import { centsToValue } from "../money.ts";

export type FinalDecision = "AUTO_APPROVE" | "ASK_HUMAN" | "DENY";

/** Structured output the auditor (Claude or mock) must return. */
export const AuditVerdictSchema = z.object({
  decision: z.enum(["AUTO_APPROVE", "ASK_HUMAN", "DENY"]),
  risk: z.number().int().min(0).max(10),
  reason_en: z.string().min(1).max(400),
  reason_ko: z.string().min(1).max(400),
});
export type AuditVerdict = z.infer<typeof AuditVerdictSchema>;

/**
 * What the LLM sees. Deliberately excludes PayPal credentials, vault_id, API keys, order ids and
 * anything else from the workspace row.
 */
export interface AuditInput {
  mandate: {
    purpose: string;
    categories: string[];
    allowed_merchants: string[];
    blocked_merchants: string[];
    monthly_limit: string;
    auto_approve_limit: string;
    per_purchase_cap: string | null;
    currency: string;
  };
  request: {
    merchant: string;
    amount: string;
    currency: string;
    items: string;
    reason: string;
    category: string | null;
  };
  month_spent: string;
  recent: Array<{ merchant: string; amount: string; status: string; created_at: string }>;
  /** S3 patterns Reins detected in code (only present when there are any). The auditor explains them. */
  signals?: Array<{ code: string; detail: string }>;
}

export interface AuditProvider {
  readonly name: string;
  /** `onUsage` lets a provider report the tokens it used (shown as "Model: Claude · 412 tokens · 1.9 s"). */
  audit(input: AuditInput, opts?: { signal?: AbortSignal; onUsage?: (tokens: number) => void }): Promise<AuditVerdict>;
}

export const RECENT_LIMIT = 10;

export function buildAuditInput(
  mandate: Mandate,
  request: Pick<PurchaseRequest, "merchant" | "amountCents" | "currency" | "items" | "reason" | "category">,
  recent: Array<Pick<PurchaseRequest, "merchant" | "amountCents" | "status" | "createdAt">>,
  monthSpentCents: number,
  signals: Array<{ code: string; detail_en: string }> = [],
): AuditInput {
  const input: AuditInput = {
    mandate: {
      purpose: mandate.purpose,
      categories: mandate.categories,
      allowed_merchants: mandate.allowedMerchants,
      blocked_merchants: mandate.blockedMerchants,
      monthly_limit: centsToValue(mandate.monthlyLimitCents),
      auto_approve_limit: centsToValue(mandate.autoApproveLimitCents),
      per_purchase_cap: mandate.perTxCapCents == null ? null : centsToValue(mandate.perTxCapCents),
      currency: mandate.currency,
    },
    request: {
      merchant: request.merchant,
      amount: centsToValue(request.amountCents),
      currency: request.currency,
      items: request.items,
      reason: request.reason,
      category: request.category,
    },
    month_spent: centsToValue(monthSpentCents),
    recent: recent.slice(0, RECENT_LIMIT).map((r) => ({
      merchant: r.merchant,
      amount: centsToValue(r.amountCents),
      status: r.status,
      created_at: new Date(r.createdAt).toISOString(),
    })),
  };
  if (signals.length) input.signals = signals.map((a) => ({ code: a.code, detail: a.detail_en }));
  return input;
}

export const RISK_AUTO_MAX = 3;
export const RISK_DENY_MIN = 8;

/**
 * Code-enforced boundaries around the model's verdict:
 * - DENY if the model says DENY (clear mismatch) or risk >= 8
 * - AUTO_APPROVE only if the model says so AND risk <= 3 AND amount <= auto-approve limit
 * - everything else ASK_HUMAN
 */
export function combineVerdict(verdict: AuditVerdict, amountCents: number, autoApproveLimitCents: number): FinalDecision {
  if (verdict.decision === "DENY" || verdict.risk >= RISK_DENY_MIN) return "DENY";
  if (verdict.decision === "AUTO_APPROVE" && verdict.risk <= RISK_AUTO_MAX && amountCents <= autoApproveLimitCents) {
    return "AUTO_APPROVE";
  }
  return "ASK_HUMAN";
}

/**
 * Reasons are shown to humans and returned to the agent. Never echo the agent's raw text back (it may carry
 * an injected prompt): any run of 24+ characters copied from items/reason is replaced.
 */
export function sanitizeReason(reason: string, request: { items: string; reason: string }): string {
  let out = reason.replace(/\s+/g, " ").trim();
  for (const source of [request.reason, request.items]) {
    const src = source.replace(/\s+/g, " ").trim();
    if (src.length < 24) continue;
    for (let len = Math.min(src.length, 200); len >= 24; len--) {
      let replaced = false;
      for (let i = 0; i + len <= src.length; i++) {
        const chunk = src.slice(i, i + len);
        if (out.includes(chunk)) {
          out = out.split(chunk).join("[request text]");
          replaced = true;
        }
      }
      if (replaced) break;
    }
  }
  return out.length > 300 ? `${out.slice(0, 297)}...` : out;
}

export interface AuditOutcome {
  final: FinalDecision;
  risk: number | null;
  reasonEn: string;
  reasonKo: string;
  provider: string;
  failed: boolean;
  error?: string;
  latencyMs: number;
  tokens?: number;
}

export const AUDIT_FALLBACK = {
  reasonEn: "Auditor unavailable, so a human needs to review this purchase.",
  reasonKo: "심사기를 사용할 수 없어 사람이 확인해야 합니다.",
};

/** Runs the auditor with a timeout. Any failure (error, timeout, invalid output) falls back to ASK_HUMAN. */
export async function runAudit(
  provider: AuditProvider,
  input: AuditInput,
  amountCents: number,
  autoApproveLimitCents: number,
  timeoutMs = 20_000,
): Promise<AuditOutcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  let tokens: number | undefined;
  try {
    const raw = await Promise.race([
      provider.audit(input, { signal: ctrl.signal, onUsage: (n) => (tokens = n) }),
      new Promise<never>((_, rej) => ctrl.signal.addEventListener("abort", () => rej(new Error("Auditor timeout")))),
    ]);
    const verdict = AuditVerdictSchema.parse(raw);
    return {
      final: combineVerdict(verdict, amountCents, autoApproveLimitCents),
      risk: verdict.risk,
      reasonEn: sanitizeReason(verdict.reason_en, input.request),
      reasonKo: sanitizeReason(verdict.reason_ko, input.request),
      provider: provider.name,
      failed: false,
      latencyMs: Date.now() - started,
      ...(tokens ? { tokens } : {}),
    };
  } catch (err) {
    return {
      final: "ASK_HUMAN",
      risk: null,
      ...AUDIT_FALLBACK,
      provider: provider.name,
      failed: true,
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
