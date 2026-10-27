import { merchantInList } from "../merchant.ts";
import { toCents } from "../money.ts";
import type { AuditInput, AuditProvider, AuditVerdict } from "./audit.ts";

const INJECTION =
  /(ignore (all |any )?(previous|prior|above) (instructions|rules)|instructed by (the )?(page|website|site|document)|system prompt|as the page (says|instructs)|the (page|website) (told|tells|asked) me|override (the )?(mandate|policy|limits?)|do not ask the (user|human))/i;

const STOP = new Set(["the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "my", "our", "with", "keep", "buy"]);
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

/**
 * Deterministic stand-in for the Claude auditor (no API key, tests, offline demo). Mirrors the rubric in the
 * Claude system prompt so golden cases behave the same shape in both.
 */
export class MockAuditor implements AuditProvider {
  readonly name = "mock";

  async audit(input: AuditInput): Promise<AuditVerdict> {
    const { mandate, request, recent } = input;
    const text = `${request.items} ${request.reason}`;
    const amount = toCents(request.amount);
    const autoLimit = toCents(mandate.auto_approve_limit);

    if (INJECTION.test(text)) {
      return {
        decision: "DENY",
        risk: 9,
        reason_en: "The request reason looks like a prompt injection from external content, not the user's intent.",
        reason_ko: "요청 사유가 사용자 의도가 아니라 외부 콘텐츠의 프롬프트 주입으로 보입니다.",
      };
    }
    if (mandate.blocked_merchants.length && merchantInList(request.merchant, mandate.blocked_merchants)) {
      return {
        decision: "DENY",
        risk: 8,
        reason_en: `${request.merchant} is explicitly blocked by the mandate.`,
        reason_ko: `${request.merchant}은(는) 위임장에서 차단된 판매자입니다.`,
      };
    }

    let risk = 1;
    const notes_en: string[] = [];
    const notes_ko: string[] = [];

    if (request.category && mandate.categories.length && !mandate.categories.includes(request.category)) {
      risk += 4;
      notes_en.push(`category "${request.category}" is outside the mandate`);
      notes_ko.push(`카테고리 "${request.category}"가 위임장 범위 밖입니다`);
    }
    const purposeWords = new Set([...words(mandate.purpose), ...mandate.categories.flatMap(words)]);
    const overlap = words(text).some((w) => purposeWords.has(w));
    if (!overlap && purposeWords.size > 0) {
      risk += 3;
      notes_en.push("the stated reason does not clearly match the mandate purpose");
      notes_ko.push("요청 사유가 위임장 목적과 뚜렷하게 맞지 않습니다");
    }
    const sameMerchant = recent.filter((r) => r.merchant === request.merchant).length;
    if (sameMerchant >= 3) {
      risk += 3;
      notes_en.push(`${sameMerchant} recent purchases from the same merchant`);
      notes_ko.push(`같은 판매자 최근 구매 ${sameMerchant}건`);
    }
    const overAuto = amount > autoLimit;
    if (overAuto) {
      risk += 1;
      notes_en.push(`$${request.amount} is above the $${mandate.auto_approve_limit} auto-approve limit`);
      notes_ko.push(`$${request.amount}은(는) 자동승인 한도 $${mandate.auto_approve_limit}를 넘습니다`);
    }
    risk = Math.min(risk, 10);

    const decision: AuditVerdict["decision"] = risk >= 8 ? "DENY" : risk <= 3 && !overAuto ? "AUTO_APPROVE" : "ASK_HUMAN";
    const reason_en = notes_en.length
      ? `${cap(notes_en.join("; "))}.`
      : `Fits the mandate purpose and is within limits.`;
    const reason_ko = notes_ko.length ? `${notes_ko.join("; ")}.` : "위임장 목적에 맞고 한도 안입니다.";
    return { decision, risk, reason_en, reason_ko };
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
