"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useSearchParams } from "next/navigation";
import type { InboxItem, LedgerRow } from "@reins/core";
import { api, ApiError } from "@/lib/api";
import { useLive } from "@/lib/live";
import { Icon } from "@/components/Icon";
import { ago, decisionLabel, hardRules, riskClass, statusChip, usd } from "@/lib/format";

const DENY_REASONS = ["Not needed", "Wrong item", "Too expensive"];

function QueueItem({ row, selected, onSelect }: { row: InboxItem; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button className="pick" aria-current={selected} onClick={onSelect}>
        <span className="row between">
          <span className="label">{row.agent_name}</span>
          <span className="amount num" style={{ fontSize: 16 }}>${row.amount}</span>
        </span>
        <span className="caption">
          {row.merchant} · {ago(row.created_at)}
        </span>
        <span className="row">
          <span className="status status-warn">ASK_HUMAN</span>
          <span className={riskClass(row.risk)}>Risk {row.risk ?? "?"}</span>
          {row.needs_clarification && <span className="status status-info">Waiting for agent</span>}
          {row.anomalies?.length > 0 && <span className="status status-bad">Unusual pattern</span>}
          <span className="caption mono">{row.display_id}</span>
        </span>
      </button>
    </li>
  );
}

function Activity({ row }: { row: InboxItem }) {
  const hard = row.decisions.find((d) => d.stage === "hard_rules");
  const llm = row.decisions.find((d) => d.stage === "llm");
  const rules = hardRules(row);
  return (
    <ol className="timeline" aria-label={`Activity for ${row.display_id}`}>
      <li>
        <span className="label">Request received via MCP</span>
        <span className="caption">{new Date(row.created_at).toLocaleTimeString()}</span>
      </li>
      {hard && (
        <li className={hard.decision === "DENY" ? "bad" : undefined}>
          <span className="label">Hard rules · {rules.filter((r) => r.ok).length} of {rules.length} passed</span>
        </li>
      )}
      {llm && (
        <li>
          <span className="label">Claude review · {llm.decision} · Risk {llm.risk ?? "?"}/10</span>
          <span className="caption">{llm.actor === "mock" ? "Offline mock auditor" : llm.actor}</span>
        </li>
      )}
      {row.messages.map((m, i) => (
        <li key={i}>
          <span className="label">{m.role === "human" ? `You asked (${m.actor ?? "web"})` : `${row.agent_name} answered`}</span>
          <span className="caption">{new Date(m.created_at).toLocaleTimeString()}</span>
        </li>
      ))}
      <li className="wait">
        <span className="label">{row.needs_clarification ? "Waiting for the agent's answer" : "Waiting for you"}</span>
        <span className="caption">{ago(row.updated_at)}</span>
      </li>
    </ol>
  );
}

function AskAgent({ row, onAsked }: { row: InboxItem; onAsked: (r: LedgerRow) => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = row.clarification;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onAsked(await api<LedgerRow>(`/api/requests/${row.request_id}/ask`, { method: "POST", body: { question: q } }));
      setQ("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="stack-s" aria-labelledby={`ask-${row.request_id}`}>
      <h3 id={`ask-${row.request_id}`}>Ask agent</h3>
      {c && (
        <div className="stack-s" aria-live="polite">
          <p className="bubble">
            <span className="caption">You asked</span>
            <br />
            {c.question}
          </p>
          {c.answer ? (
            <p className="bubble agent">
              <span className="caption">{row.agent_name} answered</span>
              <br />
              {c.answer_summary && (
                <>
                  <strong>{c.answer_summary}</strong> <span className="caption">(AI summary)</span>
                  <br />
                </>
              )}
              {c.answer}
            </p>
          ) : (
            <p className="caption row">
              <Icon name="clock" className="ico" /> Waiting for {row.agent_name} to answer through MCP. This card updates by itself.
            </p>
          )}
        </div>
      )}
      {!row.needs_clarification && (
        <form className="row" onSubmit={submit} style={{ flexWrap: "nowrap" }}>
          <label className="sr-only" htmlFor={`q-${row.request_id}`}>
            Question for {row.agent_name}
          </label>
          <input id={`q-${row.request_id}`} className="input" placeholder={`What should I ask ${row.agent_name}?`} value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} />
          <button className="btn" disabled={busy || !q.trim()}>
            {busy ? "Sending…" : "Ask"}
          </button>
        </form>
      )}
      {error && <p className="alert" role="alert">{error}</p>}
    </section>
  );
}

function Detail({
  row,
  busy,
  onDecide,
  onAsked,
}: {
  row: InboxItem;
  busy: boolean;
  onDecide: (action: "approve" | "deny", note?: string, allowMerchant?: boolean) => void;
  onAsked: (r: LedgerRow) => void;
}) {
  const [denyOpen, setDenyOpen] = useState(false);
  const [denyNote, setDenyNote] = useState("");
  const rules = hardRules(row);
  const llm = row.decisions.find((d) => d.stage === "llm");
  const amountCents = Math.round(Number(row.amount) * 100);
  const limit = row.budget.monthly_limit_cents;
  const after = limit == null ? null : limit - row.budget.month_spent_cents - amountCents;
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    setDenyOpen(false);
    setDenyNote("");
  }, [row.request_id]);

  function onKey(e: KeyboardEvent) {
    if (busy || (e.target as HTMLElement).closest("input, textarea")) return;
    if (e.key === "a" || e.key === "A") onDecide("approve");
    if (e.key === "d" || e.key === "D") setDenyOpen(true);
  }

  return (
    <article ref={ref} className="panel stack-l" tabIndex={-1} onKeyDown={onKey} aria-labelledby="detail-title">
      <header className="stack-s">
        <span className="caption mono">{row.display_id} · requested via MCP request_purchase</span>
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <div className="stack-s">
            <h2 id="detail-title">{row.items}</h2>
            <span className="caption">
              {row.agent_name} · {row.merchant} · {ago(row.created_at)} · mandate v{row.mandate_version ?? "-"}
            </span>
          </div>
          <div className="stack-s" style={{ alignItems: "flex-end" }}>
            <span className="status status-warn">ASK_HUMAN</span>
            <span className="metric">
              ${row.amount} <span className="caption">{row.currency}</span>
            </span>
          </div>
        </div>
      </header>

      <section className="stack-s">
        <h3>Why (agent)</h3>
        <p className="bubble">“{row.agent_reason}”</p>
      </section>

      {row.anomalies?.length > 0 && (
        <section className="alert alert-bad stack-s" aria-labelledby="pattern-h">
          <h3 id="pattern-h">Unusual pattern · risk +{row.anomalies.reduce((s, a) => s + a.weight, 0)}</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {row.anomalies.map((a) => (
              <li key={a.code}>{a.detail_en}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid-2">
        <section className="stack-s" aria-labelledby="checks-h">
          <h3 id="checks-h">
            Mandate check · {rules.filter((r) => r.ok).length} of {rules.length} pass
          </h3>
          <ul className="checks">
            {rules.every((r) => r.ok) && rules.length > 0 && (
              <li>
                <Icon name="check" label="Pass" />
                <details>
                  <summary>All {rules.length} hard rules passed</summary>
                  <ul className="caption" style={{ margin: 0, paddingLeft: 16 }}>
                    {rules.map((r) => (
                      <li key={r.rule}>{r.detail}</li>
                    ))}
                  </ul>
                </details>
                <span className="status status-ok">PASS</span>
              </li>
            )}
            {rules.filter((r) => !r.ok).map((r) => (
              <li key={r.rule} className={r.ok ? undefined : "fail"}>
                <Icon name={r.ok ? "check" : "warn"} label={r.ok ? "Pass" : "Fail"} />
                <span>{r.detail}</span>
                <span className={r.ok ? "status status-ok" : "status status-warn"}>{r.ok ? "PASS" : "FAIL"}</span>
              </li>
            ))}
            {limit != null && row.budget.auto_approve_limit_cents != null && (
              <li className={amountCents > row.budget.auto_approve_limit_cents ? "fail" : undefined}>
                <Icon name={amountCents > row.budget.auto_approve_limit_cents ? "warn" : "check"} label="Auto-approve limit" />
                <span>
                  Auto-approve limit: ${row.amount} {amountCents > row.budget.auto_approve_limit_cents ? ">" : "≤"} {usd(row.budget.auto_approve_limit_cents)}
                </span>
                <span className={amountCents > row.budget.auto_approve_limit_cents ? "status status-warn" : "status status-ok"}>{amountCents > row.budget.auto_approve_limit_cents ? "ASK" : "PASS"}</span>
              </li>
            )}
          </ul>
        </section>
        <section className="stack-s" aria-labelledby="audit-h">
          <h3 id="audit-h">Reins check</h3>
          <p className="row">
            <span className={riskClass(row.risk)}>Risk {row.risk ?? "?"}/10</span>
            <span className="caption">{llm?.actor === "mock" ? "mock auditor" : "Claude"}</span>
          </p>
          <p>{llm?.reasonEn ?? row.reason ?? "No auditor reason"}</p>
          {llm?.reasonKo && <p className="caption" lang="ko">{llm.reasonKo}</p>}
          {after != null && (
            <div className="stack-s">
              <span className="label">
                After approval: {usd(Math.max(after, 0))} of {usd(limit!)} left
              </span>
              <div className={after < 0 ? "bar bad" : "bar"} aria-hidden>
                <i style={{ width: `${Math.min(100, ((row.budget.month_spent_cents + amountCents) / limit!) * 100)}%` }} />
              </div>
              <span className="caption">{usd(row.budget.month_spent_cents)} used before this request</span>
            </div>
          )}
        </section>
      </div>

      <div className="grid-2">
        <section className="stack-s">
          <h3>Activity</h3>
          <Activity row={row} />
        </section>
        <AskAgent row={row} onAsked={onAsked} />
      </div>

      <footer className="stack-s">
        {denyOpen ? (
          <div className="stack-s" role="group" aria-label="Deny reason">
            <span className="label">Why deny? (sent to the agent)</span>
            <div className="row">
              {DENY_REASONS.map((r) => (
                <button key={r} type="button" className="chip-btn" aria-pressed={denyNote === r} onClick={() => setDenyNote(r)}>
                  {r}
                </button>
              ))}
            </div>
            <div className="row">
              <button className="btn btn-danger" disabled={busy} onClick={() => onDecide("deny", denyNote || undefined)} autoFocus>
                Deny {row.display_id}
              </button>
              <button className="btn-link" onClick={() => setDenyOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button className="btn btn-primary btn-lg" disabled={busy} onClick={() => onDecide("approve")}>
              {busy ? "Paying…" : `Approve $${row.amount}`}
            </button>
            <button className="btn btn-lg" disabled={busy} onClick={() => setDenyOpen(true)}>
              Deny
            </button>
            <span className="caption">
              <kbd>A</kbd> approve · <kbd>D</kbd> deny (when this panel has focus)
            </span>
          </div>
        )}
        {!denyOpen && (
          <div className="row">
            <button className="btn btn-wrap" disabled={busy} onClick={() => onDecide("approve", undefined, true)} aria-describedby={`allow-${row.request_id}`}>
              Approve + always allow {row.merchant}
            </button>
            <span id={`allow-${row.request_id}`} className="caption">
              Saves mandate v{(row.mandate_version ?? 0) + 1}: {row.merchant} up to ${row.amount} skips approval. Caps and block list still apply.
            </span>
          </div>
        )}
      </footer>
    </article>
  );
}

function RecentDecisions({ rows }: { rows: LedgerRow[] | null }) {
  if (!rows?.length) return null;
  return (
    <section className="stack-s" aria-labelledby="recent-h">
      <h3 id="recent-h" className="section-title">Recent decisions</h3>
      <ul className="list">
        {rows.map((r) => {
          const chip = statusChip(r);
          return (
            <li key={r.request_id} className="row between">
              <span className="stack-s" style={{ gap: 0 }}>
                <span className="label">{r.agent_name}</span>
                <span className="caption">
                  {r.merchant} · {decisionLabel(r)}
                </span>
              </span>
              <span className="row">
                <span className="num">${r.amount}</span>
                <span className={chip.className}>{chip.label}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function InboxScreen() {
  const params = useSearchParams();
  const [rows, setRows] = useState<InboxItem[] | null>(null);
  const [recent, setRecent] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(params.get("r"));
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ items: InboxItem[] }>("/api/inbox")
      .then((r) => {
        setRows(r.items);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
    api<{ rows: LedgerRow[] }>("/api/ledger?limit=3&status=paid,denied,expired,failed,awaiting_buyer")
      .then((r) => setRecent(r.rows))
      .catch(() => setRecent(null));
  }, []);

  useEffect(load, [load]);
  useLive(load);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const selected = useMemo(() => rows?.find((r) => r.request_id === selectedId) ?? rows?.[0] ?? null, [rows, selectedId]);

  async function decide(id: string, action: "approve" | "deny", note?: string, allowMerchant = false) {
    setBusy(id);
    try {
      const row = await api<LedgerRow & { rule?: { sentence: string } }>(`/api/requests/${id}/decision`, {
        method: "POST",
        body: allowMerchant ? { action, allow_merchant: true } : { action, note },
      });
      const rule = row.rule ? ` Rule saved: ${row.rule.sentence}` : "";
      setNotice(
        (row.status === "paid"
          ? `Paid $${row.amount} · capture ${row.receipt?.capture_id?.slice(0, 6) ?? ""}…`
          : row.status === "awaiting_buyer"
            ? "Approved. Finish checkout on PayPal (opened in a new tab)."
            : row.status === "denied"
              ? `${row.display_id} denied. The agent was told.`
              : row.status === "failed"
                ? `PayPal did not complete ${row.display_id}. Nothing was charged.`
                : `${row.display_id} ${row.status}`) + rule,
      );
      if (row.status === "awaiting_buyer" && row.payment?.approve_url) window.open(row.payment.approve_url, "_blank", "noopener");
      setSelectedId(null);
    } catch (e) {
      setNotice(e instanceof ApiError && e.code === "already_decided" ? "Already decided on another device (Telegram)." : e instanceof ApiError && e.code === "expired" ? "This request expired; the agent was told to ask again." : (e as Error).message);
    } finally {
      setBusy(null);
      load();
    }
  }

  function onAsked(r: LedgerRow) {
    setNotice(`Question sent to ${r.agent_name}.`);
    load();
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p className="muted">Purchases the rules and the auditor want you to look at. Same queue as Telegram.</p>
        </div>
        {rows && <span className="caption">{rows.length} pending</span>}
      </div>
      {error ? (
        <div className="panel stack">
          <p className="alert alert-bad" role="alert">
            Could not load approvals: {error}
          </p>
          <div>
            <button className="btn" onClick={load}>
              Retry
            </button>
          </div>
        </div>
      ) : rows === null ? (
        <div className="split" aria-busy="true" aria-label="Loading approvals">
          <div className="stack-s">
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
          <div className="skeleton" style={{ minHeight: 320 }} />
        </div>
      ) : rows.length === 0 ? (
        <div className="split">
          <section className="panel stack" aria-live="polite">
            <div className="empty">
              <h2>All clear</h2>
              <p className="muted">Nothing waiting for you. New requests appear here and on Telegram instantly.</p>
            </div>
            <RecentDecisions rows={recent} />
          </section>
        </div>
      ) : (
        <div className="split">
          <section className="panel panel-tight stack" aria-label="Pending requests">
            <ul className="pick-list" aria-live="polite">
              {rows.map((r) => (
                <QueueItem key={r.request_id} row={r} selected={selected?.request_id === r.request_id} onSelect={() => setSelectedId(r.request_id)} />
              ))}
            </ul>
            <RecentDecisions rows={recent} />
          </section>
          {selected && <Detail row={selected} busy={busy === selected.request_id} onDecide={(a, n, allow) => decide(selected.request_id, a, n, allow)} onAsked={onAsked} />}
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
    </>
  );
}

export default function InboxPage() {
  return (
    <Suspense fallback={<div className="skeleton" aria-label="Loading approvals" />}>
      <InboxScreen />
    </Suspense>
  );
}
