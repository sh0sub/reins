import type { RequestAnomaly } from "@reins/db";
import { merchantInList } from "../merchant.ts";
import { RISK_DENY_MIN, type FinalDecision } from "./audit.ts";

/**
 * Feature S3: unusual-pattern detection. Deterministic checks run in code next to the auditor:
 * - repeat_merchant: this is at least the REPEAT_MERCHANT_MIN-th request to the same merchant within 24 hours
 * - late_night: requested inside the workspace's quiet hours (local time)
 * - off_mandate_category: the agent's category is not one of the mandate's categories
 * Each hit adds risk points and turns an AUTO_APPROVE into ASK_HUMAN with a warning. Patterns never block on
 * their own (hard rules and the auditor do that); a human looks instead.
 */

export const REPEAT_MERCHANT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Counting this request: the 4th request to one merchant inside the window is flagged (3 renewals in a day are normal). */
export const REPEAT_MERCHANT_MIN = 4;
export const ANOMALY_WEIGHTS: Record<RequestAnomaly["code"], number> = { repeat_merchant: 2, late_night: 1, off_mandate_category: 2 };

export interface QuietHours {
  /** IANA zone, e.g. "Asia/Seoul". */
  timeZone: string;
  /** Local hour the quiet window starts (inclusive, 0-23). */
  startHour: number;
  /** Local hour the quiet window ends (exclusive, 0-24). May be smaller than startHour to wrap midnight. */
  endHour: number;
}

export interface AnomalyInput {
  request: { merchant: string; category: string | null; createdAt: number };
  mandate: { categories: string[] } | null;
  /** Other requests by the same agent (any status), newest first. */
  recent: Array<{ merchant: string; createdAt: number }>;
  quietHours?: QuietHours | null;
}

/** Local wall-clock hour and "HH:MM" for `ts` in `timeZone`. */
export function localTime(ts: number, timeZone: string): { hour: number; label: string } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ts);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return { hour: Number(hh) % 24, label: `${hh}:${mm}` };
}

export function inQuietHours(hour: number, q: Pick<QuietHours, "startHour" | "endHour">): boolean {
  return q.startHour <= q.endHour ? hour >= q.startHour && hour < q.endHour : hour >= q.startHour || hour < q.endHour;
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

export function detectAnomalies(input: AnomalyInput): RequestAnomaly[] {
  const { request, mandate, recent, quietHours } = input;
  const out: RequestAnomaly[] = [];

  const since = request.createdAt - REPEAT_MERCHANT_WINDOW_MS;
  const same = recent.filter((r) => r.createdAt >= since && r.createdAt <= request.createdAt && merchantInList(r.merchant, [request.merchant])).length;
  if (same + 1 >= REPEAT_MERCHANT_MIN) {
    out.push({
      code: "repeat_merchant",
      weight: ANOMALY_WEIGHTS.repeat_merchant,
      detail_en: `${ordinal(same + 1)} request to ${request.merchant} in 24 hours`,
      detail_ko: `24시간 안에 ${request.merchant} 요청 ${same + 1}번째`,
    });
  }

  if (quietHours) {
    const t = localTime(request.createdAt, quietHours.timeZone);
    if (inQuietHours(t.hour, quietHours)) {
      out.push({
        code: "late_night",
        weight: ANOMALY_WEIGHTS.late_night,
        detail_en: `Requested at ${t.label} (${quietHours.timeZone}), inside quiet hours`,
        detail_ko: `${quietHours.timeZone} 기준 ${t.label} 심야 요청`,
      });
    }
  }

  if (request.category && mandate && mandate.categories.length > 0 && !mandate.categories.includes(request.category)) {
    out.push({
      code: "off_mandate_category",
      weight: ANOMALY_WEIGHTS.off_mandate_category,
      detail_en: `Category "${request.category}" is outside the mandate (${mandate.categories.join(", ")})`,
      detail_ko: `카테고리 "${request.category}"는 위임장 범위(${mandate.categories.join(", ")}) 밖`,
    });
  }
  return out;
}

/**
 * Weighs the auditor outcome with detected patterns: AUTO_APPROVE becomes ASK_HUMAN, risk grows by the weights.
 * A non-DENY result stays below the auditor's DENY threshold so patterns alone never block a purchase.
 */
export function applyAnomalies(final: FinalDecision, risk: number | null, anomalies: RequestAnomaly[]): { final: FinalDecision; risk: number | null; escalated: boolean } {
  if (!anomalies.length) return { final, risk, escalated: false };
  const weight = anomalies.reduce((s, a) => s + a.weight, 0);
  if (final === "DENY") return { final, risk: risk == null ? null : Math.min(10, risk + weight), escalated: false };
  const weighted = risk == null ? null : Math.min(RISK_DENY_MIN - 1, risk + weight);
  return { final: "ASK_HUMAN", risk: weighted, escalated: final === "AUTO_APPROVE" };
}

/** One-line warning shown on the card and in the inbox. */
export function anomalySummary(anomalies: RequestAnomaly[], lang: "en" | "ko" = "en"): string | null {
  if (!anomalies.length) return null;
  const parts = anomalies.map((a) => (lang === "ko" ? a.detail_ko : a.detail_en));
  return lang === "ko" ? `이상 패턴: ${parts.join("; ")}.` : `Unusual pattern: ${parts.join("; ")}.`;
}
