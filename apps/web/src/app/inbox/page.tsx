"use client";

import { useCallback, useEffect, useState } from "react";
import type { LedgerRow } from "@reins/core";
import { api, ApiError, subscribeEvents } from "@/lib/api";

type RuleResult = { rule: string; ok: boolean; detail: string };

function riskClass(risk: number | null) {
  if (risk == null) return "status";
  return risk <= 3 ? "status status-ok" : risk >= 8 ? "status status-bad" : "status status-warn";
}

function InboxItem({ row, onDecide, busy }: { row: LedgerRow; onDecide: (id: string, action: "approve" | "deny") => void; busy: boolean }) {
  const rules = (row.decisions.find((d) => d.stage === "hard_rules")?.details as { results?: RuleResult[] } | null)?.results ?? [];
  const audit = row.decisions.find((d) => d.stage === "llm");
  return (
    <li>
      <article className="stack" aria-labelledby={`t-${row.request_id}`}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h3 id={`t-${row.request_id}`}>{row.agent_name} wants to pay {row.merchant}</h3>
            <p className="caption" style={{ margin: 0 }}>
              {row.display_id} · {new Date(row.created_at).toLocaleString()} · mandate v{row.mandate_version ?? "-"}
            </p>
          </div>
          <span className="amount">${row.amount}</span>
        </div>
        <p style={{ margin: 0 }}>{row.items}</p>
        <div className="row">
          <span className={riskClass(row.risk)}>Risk {row.risk ?? "?"}/10</span>
          <span className="muted">{audit?.reasonEn ?? row.reason ?? "No auditor reason"}</span>
        </div>
        {rules.length > 0 && (
          <details>
            <summary className="caption">Hard rules: {rules.filter((r) => r.ok).length}/{rules.length} passed</summary>
            <ul className="rules">
              {rules.map((r) => (
                <li key={r.rule}>
                  <span className={r.ok ? "status status-ok" : "status status-bad"}>{r.ok ? "PASS" : "FAIL"}</span>
                  <span>{r.detail}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="row">
          <button className="btn btn-primary" disabled={busy} onClick={() => onDecide(row.request_id, "approve")}>
            Approve ${row.amount}
          </button>
          <button className="btn" disabled={busy} onClick={() => onDecide(row.request_id, "deny")}>
            Deny
          </button>
        </div>
      </article>
    </li>
  );
}

export default function InboxPage() {
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ items: LedgerRow[] }>("/api/inbox")
      .then((r) => {
        setRows(r.items);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    return subscribeEvents(load);
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  async function decide(id: string, action: "approve" | "deny") {
    setBusy(id);
    try {
      const row = await api<LedgerRow>(`/api/requests/${id}/decision`, { method: "POST", body: { action } });
      setNotice(
        row.status === "paid"
          ? `Paid $${row.amount} · Capture ${row.receipt?.capture_id?.slice(0, 6) ?? ""}…`
          : row.status === "awaiting_buyer"
            ? `Approved. Finish checkout on PayPal.`
            : `${row.display_id} ${row.status}`,
      );
      if (row.status === "awaiting_buyer" && row.payment?.approve_url) window.open(row.payment.approve_url, "_blank", "noopener");
    } catch (e) {
      setNotice(e instanceof ApiError && e.code === "already_decided" ? "Already decided on another device" : (e as Error).message);
    } finally {
      setBusy(null);
      load();
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p className="muted" style={{ margin: 0 }}>Purchases the rules and the auditor want you to look at. Same queue as Telegram.</p>
        </div>
      </div>
      <section className="panel" aria-live="polite" aria-busy={rows === null}>
        {error ? (
          <div className="stack">
            <p className="alert" role="alert">Could not load approvals: {error}</p>
            <div><button className="btn" onClick={load}>Retry</button></div>
          </div>
        ) : rows === null ? (
          <div className="skeleton" aria-label="Loading approvals" />
        ) : rows.length === 0 ? (
          <div className="stack">
            <h2>All clear</h2>
            <p className="muted" style={{ margin: 0 }}>No purchases are waiting for you. New requests appear here instantly.</p>
          </div>
        ) : (
          <ul className="list">
            {rows.map((r) => (
              <InboxItem key={r.request_id} row={r} onDecide={decide} busy={busy === r.request_id} />
            ))}
          </ul>
        )}
      </section>
      {notice && <div className="toast" role="status">{notice}</div>}
    </>
  );
}
