import type { AttackSuiteResult } from "@reins/core";
import { usdAmount } from "@/lib/format";

const RULE_WORDS: Record<string, string> = {
  per_tx_cap: "per-purchase cap",
  monthly_limit: "monthly limit",
  allowlist: "allow list",
  merchant_total: "same-merchant total",
  currency: "currency",
  agent_paused: "agent paused",
  idempotency: "request id seen before",
  human_approval: "a person must approve",
  velocity: "velocity",
};
const money = (cents: number) => usdAmount(cents / 100);

/** Read-only "Without Reins / With Reins" panel. The numbers come from real runs of the rule engine (see runAttackSuite). */
export function AttackSuite({ suite }: { suite: AttackSuiteResult }) {
  return (
    <section className="panel stack attacks" aria-labelledby="attacks-h">
      <div className="stack-s">
        <div className="row between">
          <h2 id="attacks-h" className="h-card">
            Without Reins / With Reins
          </h2>
          <span className="status status-info">Simulated benchmark</span>
        </div>
        <p className="muted">
          The same {suite.attacks.length} scripted attacks, sent to an ungated agent (a shared card or token that pays what it is told) and through the real Reins rule engine. The auditor is set to approve everything, so only the code rules
          stand in the way. Run it yourself: <code>pnpm attacks</code>.
        </p>
      </div>
      <div className="attacks-total num" role="group" aria-label="Totals">
        <div>
          <span className="caption">Ungated agent paid</span>
          <b className="bad-text">{money(suite.ungated_paid_cents)}</b>
        </div>
        <div>
          <span className="caption">With Reins paid</span>
          <b className="ok-text">{money(suite.gated_paid_cents)}</b>
        </div>
        <div>
          <span className="caption">Kept in the wallet</span>
          <b>{money(suite.prevented_cents)}</b>
        </div>
      </div>
      <div className="attacks-scroll">
        <table className="try-rules attacks-table">
          <thead>
            <tr>
              <th scope="col">Attack</th>
              <th scope="col" className="r">
                Ungated paid
              </th>
              <th scope="col" className="r">
                With Reins paid
              </th>
              <th scope="col">What stopped it</th>
            </tr>
          </thead>
          <tbody>
            {suite.attacks.map((a) => (
              <tr key={a.id}>
                <th scope="row">
                  {a.title}
                  <span className="caption attacks-story">{a.story}</span>
                </th>
                <td className="r num bad-text" data-label="Ungated paid">{money(a.ungated_paid_cents)}</td>
                <td className="r num ok-text" data-label="With Reins paid">
                  {money(a.gated_paid_cents)}
                  {a.gated_held_cents > 0 && <span className="caption attacks-story">{money(a.gated_held_cents)} held for a person</span>}
                </td>
                <td data-label="Stopped by">{a.stopped_by.map((s) => RULE_WORDS[s] ?? s).join(", ") || "nothing needed"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="caption">
        What this shows: these scripted attacks, run through the code that guards the real wallet, with simulated PayPal (SIM ids). The ungated side is a model that pays every request, not a measurement of any product. What Reins paid is the part that
        was inside the mandate (for example the first three of the five $29 orders). It is not a claim that every attack is stopped.
      </p>
    </section>
  );
}
