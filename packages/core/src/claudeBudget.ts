import type { AuditInput, AuditProvider, AuditVerdict } from "./policy/audit.ts";

/**
 * M1 global daily cap on Claude calls (auditor, rule sentence, answer summary, weekly summary, category suggestions).
 * One counter per server process, reset at UTC midnight. When it is used up, the auditor falls back to the
 * deterministic template auditor and the other writers to their templates, so the demo keeps working and the API bill
 * stays bounded even if someone floods the public endpoints.
 */
export class DailyCallBudget {
  private day = "";
  private used = 0;
  constructor(
    readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one call from today's budget; false when it is used up. */
  take(): boolean {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }

  get remaining(): number {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    return today === this.day ? Math.max(0, this.limit - this.used) : this.limit;
  }
}

export class ClaudeBudgetExceeded extends Error {
  constructor() {
    super("Daily Claude call budget used up");
    this.name = "ClaudeBudgetExceeded";
  }
}

export const DEFAULT_CLAUDE_DAILY_CAP = 400;

/** Auditor that spends from the budget and hands over to `fallback` (the template auditor) once it is empty. */
export class BudgetedAuditor implements AuditProvider {
  constructor(
    private readonly primary: AuditProvider,
    private readonly fallback: AuditProvider,
    private readonly budget: DailyCallBudget,
  ) {}

  get name() {
    return this.primary.name;
  }

  async audit(input: AuditInput, opts: Parameters<AuditProvider["audit"]>[1] = {}): Promise<AuditVerdict> {
    if (this.budget.take()) return this.primary.audit(input, opts);
    opts.onProvider?.(this.fallback.name);
    return this.fallback.audit(input, opts);
  }
}

/**
 * Wraps one method of a Claude-backed writer so every call spends from the budget; an empty budget throws, and the
 * caller's existing template fallback takes over (writeRuleSentence, summarizeAnswer, suggestCategories, weekly summary).
 */
export function budgeted<T extends object, K extends keyof T>(target: T, method: K, budget: DailyCallBudget): T {
  const original = target[method] as unknown as (...args: unknown[]) => Promise<unknown>;
  const wrapped = Object.create(target) as T;
  (wrapped as Record<K, unknown>)[method] = async (...args: unknown[]) => {
    if (!budget.take()) throw new ClaudeBudgetExceeded();
    return original.apply(target, args);
  };
  return wrapped;
}
