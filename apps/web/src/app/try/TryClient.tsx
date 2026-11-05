"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import type { LedgerRow } from "@reins/core";
import { api } from "@/lib/api";
import { isSimId, simId, statusChip, usd } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { BLANK, PRESETS, type Preset } from "./presets";

interface Mandate {
  monthly_limit: string;
  auto_approve_limit: string;
  per_purchase_cap: string;
  allowed_merchants: string[];
  purpose: string;
}
interface Result {
  row: LedgerRow;
  auditor: "configured" | "fooled";
  failed_rules: string[];
  paypal: "sandbox" | "simulated" | "none";
}
interface RuleRow {
  rule: string;
  ok: boolean;
  detail: string;
  value?: string;
  limit?: string;
}

const RULE_LABEL: Record<string, string> = {
  agent_active: "Agent key active",
  agent_paused: "Agent not paused",
  mandate_present: "Mandate present",
  mandate_window: "Mandate window",
  amount_valid: "Amount valid",
  currency: "Currency",
  per_tx_cap: "Per-purchase cap",
  monthly_limit: "Monthly limit",
  blocked_merchant: "Merchant not blocked",
  allowlist: "Merchant allow list",
  velocity: "Velocity",
};

const rulesOf = (row: LedgerRow): RuleRow[] => (row.decisions.find((d) => d.stage === "hard_rules")?.details as { results?: RuleRow[] } | null)?.results ?? [];

/** Screen "Try": send a purchase request as an AI agent and watch the real policy engine decide. */
export default function TryClient({ enabled, agent, mandate }: { enabled: boolean; agent: string; mandate: Mandate }) {
  const [fooled, setFooled] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [history, setHistory] = useState<Array<{ id: string; label: string }>>([]);
  const [form, setForm] = useState(BLANK);
  const [decided, setDecided] = useState<string | null>(null);
  const resultRef = useRef<HTMLElement>(null);
  // on a phone the decision sits below the presets: bring it into view after each send
  const sentId = result?.row.request_id;
  useEffect(() => {
    if (sentId && window.innerWidth < 1000) resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [sentId]);

  async function send(label: string, purchase: Record<string, string>, key: string) {
    setBusy(key);
    setError(null);
    setDecided(null);
    try {
      const r = await api<Result>("/api/try", { method: "POST", body: { ...purchase, fooled_auditor: fooled } });
      setResult(r);
      setHistory((h) => [{ id: r.row.request_id, label: `${label} ${usd(Math.round(Number(r.row.amount) * 100))} · ${statusChip(r.row).label}` }, ...h].slice(0, 6));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function submitForm(e: FormEvent) {
    e.preventDefault();
    const purchase: Record<string, string> = { merchant: form.merchant, amount: form.amount, items: form.items, reason: form.reason };
    if (form.category.trim()) purchase.category = form.category.trim();
    void send(form.merchant || "Custom", purchase, "form");
  }

  async function decide(id: string, action: "approve" | "deny") {
    setBusy(action);
    try {
      const row = await api<LedgerRow>(`/api/requests/${id}/decision`, { method: "POST", body: { action } });
      setResult((r) => (r ? { ...r, row } : r));
      setDecided(action === "approve" ? "Approved by you in this playground." : "Rejected by you in this playground.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Try an agent</h1>
          <p className="tagline">You are the AI agent. Send a purchase request and watch Reins pay it, ask you, or block it. This calls the same code path as the MCP tool request_purchase.</p>
        </div>
      </div>

      {!enabled ? (
        <div className="panel stack" role="note">
          <h2>The playground is off on this server</h2>
          <p className="muted">It creates a demo agent, so it only runs on a demo instance. Start one locally with a throwaway database:</p>
          <pre className="mono try-code">pnpm judge</pre>
          <p className="caption">or set REINS_TRY=1 before starting the web app.</p>
        </div>
      ) : (
        <div className="try">
          <div className="stack-l">
            <section className="panel panel-tight stack" aria-labelledby="try-mandate">
              <h2 id="try-mandate" className="h-card row">
                <span className="status status-info" aria-hidden>
                  PA
                </span>
                {agent}
              </h2>
              <p className="caption">Mandate: {mandate.purpose}.</p>
              <ul className="try-limits num">
                <li>
                  <b>${mandate.monthly_limit}</b> per month
                </li>
                <li>
                  <b>${mandate.auto_approve_limit}</b> auto-approve limit
                </li>
                <li>
                  <b>${mandate.per_purchase_cap}</b> per purchase
                </li>
                <li>
                  only <b>{mandate.allowed_merchants.join(", ")}</b>
                </li>
              </ul>
            </section>

            <section className="stack" aria-labelledby="try-presets">
              <h2 id="try-presets" className="h-card">
                Send a request
              </h2>
              <ul className="try-presets">
                {PRESETS.map((p) => (
                  <PresetCard key={p.id} preset={p} busy={busy === p.id} disabled={busy !== null} onSend={() => void send(p.title, p.purchase, p.id)} />
                ))}
              </ul>
              <label className="try-toggle">
                <input type="checkbox" checked={fooled} onChange={(e) => setFooled(e.target.checked)} />
                <span>
                  <b>Simulate a fooled auditor</b> (always AUTO_APPROVE)
                  <span className="caption"> Try the $450 order again: the model says yes, the code still says no.</span>
                </span>
              </label>
              <details className="try-free">
                <summary>Write your own request</summary>
                <form className="stack" onSubmit={submitForm}>
                  <div className="grid-2">
                    <div className="field">
                      <label htmlFor="t-merchant">Merchant</label>
                      <input id="t-merchant" className="input" required placeholder="namecheap.com" value={form.merchant} onChange={(e) => setForm({ ...form, merchant: e.target.value })} />
                    </div>
                    <div className="field">
                      <label htmlFor="t-amount">Amount (USD)</label>
                      <input id="t-amount" className="input" required inputMode="decimal" placeholder="25.00" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="t-items">What is being bought</label>
                    <input id="t-items" className="input" required value={form.items} onChange={(e) => setForm({ ...form, items: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="t-reason">Agent&apos;s reason</label>
                    <textarea id="t-reason" className="input" rows={2} required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="t-cat">Category (optional)</label>
                    <input id="t-cat" className="input" placeholder="research" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
                  </div>
                  <div>
                    <button className="btn btn-primary" disabled={busy !== null}>
                      {busy === "form" ? "Sending…" : "Send request"}
                    </button>
                  </div>
                </form>
              </details>
              <p className="caption">Playground only: the velocity rule (3 requests per 10 minutes) is relaxed so you can click freely. Every other rule is the real one.</p>
            </section>
          </div>

          <section ref={resultRef} className="stack try-decision" aria-labelledby="try-result" aria-live="polite">
            <h2 id="try-result" className="h-card">
              Decision
            </h2>
            {error && (
              <p className="alert alert-bad" role="alert">
                {error}
              </p>
            )}
            {!result ? (
              <div className="empty try-empty">
                <p className="muted">Nothing sent yet. Start with the $450 order: it is the one a prompt-injected agent would try.</p>
              </div>
            ) : (
              <ResultPanel result={result} busy={busy} decided={decided} onDecide={(a) => void decide(result.row.request_id, a)} />
            )}
            {history.length > 1 && (
              <ul className="caption try-history" aria-label="This session">
                {history.map((h) => (
                  <li key={h.id}>
                    <Link href={`/ledger?r=${h.id}&drawer=1`}>{h.label}</Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </>
  );
}

function PresetCard({ preset, busy, disabled, onSend }: { preset: Preset; busy: boolean; disabled: boolean; onSend: () => void }) {
  const p = preset.purchase;
  return (
    <li>
      <button type="button" className={preset.id === "injection" ? "pick try-pick bad" : "pick try-pick"} disabled={disabled} onClick={onSend}>
        <span className="row between">
          <span className="label">{busy ? "Sending…" : preset.title}</span>
          <b className="num">${p.amount}</b>
        </span>
        <span className="caption">
          {p.merchant} · {preset.hint}
        </span>
      </button>
    </li>
  );
}

function ResultPanel({ result, busy, decided, onDecide }: { result: Result; busy: string | null; decided: string | null; onDecide: (a: "approve" | "deny") => void }) {
  const { row } = result;
  const chip = statusChip(row);
  const rules = rulesOf(row);
  const failed = rules.filter((r) => !r.ok);
  const llm = row.decisions.find((d) => d.stage === "llm");
  const payId = row.payment?.capture_id ?? row.payment?.payout_batch_id ?? row.payment?.order_id ?? null;
  const advisory = Boolean((llm?.details as { advisory?: boolean } | null)?.advisory);
  const fooledButBlocked = result.auditor === "fooled" && row.status === "denied";
  return (
    <div className="panel stack try-result" data-status={row.status}>
      <div className="row between">
        <div className="row">
          <span className={`${chip.className} status-lg`}>{chip.label}</span>
          <b className="num">{usd(Math.round(Number(row.amount) * 100))}</b>
          <span className="muted">{row.merchant}</span>
        </div>
        <span className="caption mono">{row.display_id}</span>
      </div>

      {row.reason && <p>{row.reason}</p>}

      {fooledButBlocked && (
        <p className="alert alert-ok row" role="note">
          <Icon name="shield" className="ico" />
          The simulated auditor said AUTO_APPROVE. The hard rules ran in code and denied it anyway.
        </p>
      )}

      <div className="stack-s">
        <h3 className="caption kpi-k">Stage 1 · hard rules (code, no model){failed.length ? ` · ${failed.length} failed` : " · all passed"}</h3>
        <table className="try-rules">
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Request</th>
              <th scope="col">Limit</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.rule} className={r.ok ? undefined : "fail"}>
                <th scope="row">{RULE_LABEL[r.rule] ?? r.rule}</th>
                <td className="num">{r.value ?? ""}</td>
                <td className="num">{r.limit ?? ""}</td>
                <td>
                  <span className={r.ok ? "status status-ok" : "status status-bad"}>{r.ok ? "Pass" : "Fail"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="stack-s">
        <h3 className="caption kpi-k">Stage 2 · auditor{advisory ? " (advisory only, the decision was already final)" : ""}</h3>
        {llm ? (
          <p>
            <span className="status">{result.auditor === "fooled" ? "simulated fooled auditor" : llm.actor === "mock" ? "demo auditor (offline stand-in)" : "Claude"}</span>{" "}
            <b>{result.auditor === "fooled" ? "AUTO_APPROVE" : llm.decision}</b>
            {llm.risk != null ? ` · risk ${llm.risk}/10` : ""}
            {result.auditor === "fooled" && llm.decision !== "AUTO_APPROVE" && <span className="muted"> · code clamped the answer to {llm.decision}</span>}{" "}
            {result.auditor !== "fooled" && <span className="muted">{llm.reasonEn}</span>}
          </p>
        ) : (
          <p className="muted">Not called: the rules stopped the request first.</p>
        )}
      </div>

      {row.status === "pending_human" && (
        <div className="stack-s">
          <p className="alert row" role="note">
            <Icon name="inbox" className="ico" />
            Above the auto-approve limit, so a person decides. In the real flow this card goes to Telegram and the web inbox.
          </p>
          <div className="row">
            <button className="btn btn-primary" disabled={busy !== null} onClick={() => onDecide("approve")}>
              {busy === "approve" ? "Approving…" : "Approve"}
            </button>
            <button className="btn btn-danger" disabled={busy !== null} onClick={() => onDecide("deny")}>
              Reject
            </button>
          </div>
        </div>
      )}
      {decided && <p className="alert alert-ok" role="status">{decided}</p>}

      {payId && (
        <p className="row">
          <span className="caption">PayPal</span>
          <span className="mono">{simId(payId)}</span>
          {isSimId(payId) ? <span className="status status-info">simulated</span> : <span className="status status-ok">sandbox</span>}
        </p>
      )}
      <div className="row">
        <Link className="btn" href={`/ledger?r=${row.request_id}&drawer=1`}>
          Open in the ledger
        </Link>
        {row.status === "paid" && row.receipt?.receipt_url && (
          <Link className="btn" href={`/receipts/${row.request_id}`}>
            Receipt
          </Link>
        )}
      </div>
    </div>
  );
}
