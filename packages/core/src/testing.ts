import { createTestDb } from "@reins/db";
import { ReinsEvents, type Notifier } from "./events.ts";
import { FakePayPalClient } from "./paypal/fake.ts";
import { MockAuditor } from "./policy/mockAuditor.ts";
import type { AuditProvider } from "./policy/audit.ts";
import type { ReinsConfig, ReinsContext } from "./service.ts";
import type { RequestView } from "./views.ts";

export { FakePayPalClient } from "./paypal/fake.ts";

export class RecordingNotifier implements Notifier {
  readonly name = "recording";
  readonly pending: RequestView[] = [];
  readonly resolvedViews: RequestView[] = [];
  async pendingHuman(v: RequestView) {
    this.pending.push(v);
  }
  async resolved(v: RequestView) {
    this.resolvedViews.push(v);
  }
}

/** Fresh in-memory context: SQLite :memory:, fake PayPal, mock auditor. */
export async function createTestContext(
  overrides: Partial<Omit<ReinsContext, "config">> & { config?: Partial<ReinsConfig>; auditor?: AuditProvider } = {},
): Promise<ReinsContext & { paypal: FakePayPalClient; notifier: RecordingNotifier }> {
  const notifier = new RecordingNotifier();
  const ctx = {
    db: overrides.db ?? (await createTestDb()),
    paypal: (overrides.paypal as FakePayPalClient | undefined) ?? new FakePayPalClient(),
    auditor: overrides.auditor ?? new MockAuditor(),
    events: overrides.events ?? new ReinsEvents(),
    notifiers: overrides.notifiers ?? [notifier],
    now: overrides.now ?? Date.now,
    config: {
      publicBaseUrl: "http://localhost:3000",
      paypalWebhookId: "WH-TEST-ID",
      treasuryPayeeEmail: "merchant@business.example.com",
      approvalTtlMs: 30 * 60 * 1000,
      explainDenials: true,
      auditTimeoutMs: 2000,
      ...overrides.config,
    },
    notifier,
  };
  return ctx as ReinsContext & { paypal: FakePayPalClient; notifier: RecordingNotifier };
}
