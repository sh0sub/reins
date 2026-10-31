"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useSearchParams } from "next/navigation";
import type { InboxItem, LedgerRow, Overview } from "@reins/core";
import { api, ApiError } from "@/lib/api";
import { useLive } from "@/lib/live";
import { Icon } from "@/components/Icon";
import { ago, hardRules, riskClass, statusChip, usd } from "@/lib/format";
import { RequestDrawer } from "@/components/RequestDrawer";

/** A request waiting longer than this counts as overdue in the queue header. */
const OVERDUE_MS = 24 * 3_600_000;
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

type MandateCheck = { key: string; label: string; note: string | null; ok: boolean };

/**
 * S5 "Mandate check · 3 of 4 pass": the four checks a person reads (merchant, monthly cap, per-purchase cap, auto-approve
 * limit). The other hard rules only appear when one of them fails.
 */
function mandateChecks(row: InboxItem, rules: ReturnType<typeof hardRules>, amountCents: number, after: number | null): MandateCheck[] {
  const rule = (code: string) => rules.find((r) => r.rule === code);
  const okOf = (code: string) => rule(code)?.ok ?? true;
  const cap = row.mandate?.per_tx_cap_cents ?? null;
  const auto = row.budget.auto_approve_limit_cents;
  const out: MandateCheck[] = [
    { key: "allowlist", label: "Merchant allowed", note: row.merchant, ok: okOf("allowlist") && okOf("blocked_merchant") },
    { key: "monthly_limit", label: "Within monthly cap", note: after == null ? null : after >= 0 ? `${usd(after)} left after` : `${usd(-after)} over`, ok: okOf("monthly_limit") },
    { key: "per_tx_cap", label: "Within per-purchase cap", note: cap == null ? null : `≤ ${usd(cap)}`, ok: okOf("per_tx_cap") },
  ];
  if (auto != null) out.push({ key: "auto", label: "Under auto-approve limit", note: `$${row.amount} ${amountCents > auto ? ">" : "≤"} ${usd(auto)}`, ok: amountCents <= auto });
  const shown = new Set(["allowlist", "blocked_merchant", "monthly_limit", "per_tx_cap"]);
  for (const r of rules) if (!r.ok && !shown.has(r.rule)) out.splice(out.length - (auto != null ? 1 : 0), 0, { key: r.rule, label: r.detail, note: null, ok: false });
  return out;
}

function Activity({ row, telegram }: { row: InboxItem; telegram: boolean }) {
  const hard = row.decisions.find((d) => d.stage === "hard_rules");
  const llm = row.decisions.find((d) => d.stage === "llm");
  // the approval card goes to Telegram the moment the request turns ASK_HUMAN (only when a chat is linked)
  const askedAt = [...row.decisions].reverse().find((d) => d.decision === "ASK_HUMAN")?.created_at;
  const rules = hardRules(row);
  return (
    <ol className="timeline" aria-label={`Activity for ${row.display_id}`}>
      <li>
        <span className="label">Request received via MCP</span>
        <span className="caption">{new Date(row.created_at).toLocaleTimeString("en-US")}</span>
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
      {telegram && askedAt && (
        <li className="tg">
          <span className="label">Sent to Telegram</span>
          <span className="caption">{new Date(askedAt).toLocaleTimeString("en-US")} · approval card</span>
        </li>
      )}
      {row.messages.map((m, i) => (
        <li key={i}>
          <span className="label">{m.role === "human" ? `You asked (${m.actor ?? "web"})` : `${row.agent_name} answered`}</span>
          <span className="caption">{new Date(m.created_at).toLocaleTimeString("en-US")}</span>
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
  telegram,
  onDecide,
  onAsked,
  onOpen,
}: {
  row: InboxItem;
  busy: boolean;
  telegram: boolean;
  onDecide: (action: "approve" | "deny", note?: string, allowMerchant?: boolean) => void;
  onAsked: (r: LedgerRow) => void;
  onOpen: (id: string) => void;
}) {
  const [denyOpen, setDenyOpen] = useState(false);
  const [denyNote, setDenyNote] = useState("");
  const [alsoAllow, setAlsoAllow] = useState(false);
  const rules = hardRules(row);
  const llm = row.decisions.find((d) => d.stage === "llm");
  const amountCents = Math.round(Number(row.amount) * 100);
  const limit = row.budget.monthly_limit_cents;
  const after = limit == null ? null : limit - row.budget.month_spent_cents - amountCents;
  const checks = mandateChecks(row, rules, amountCents, after);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    setDenyOpen(false);
    setDenyNote("");
    setAlsoAllow(false);
  }, [row.request_id]);

  function onKey(e: KeyboardEvent) {
    if (busy || (e.target as HTMLElement).closest("input, textarea")) return;
    if (e.key === "a" || e.key === "A") onDecide("approve", undefined, alsoAllow);
    if (e.key === "d" || e.key === "D") setDenyOpen(true);
  }

  return (
    <article ref={ref} className="panel stack-l" tabIndex={-1} onKeyDown={onKey} aria-labelledby="detail-title">
      <header className="stack-s">
        <div className="row between">
          <span className="caption mono">{row.display_id} · requested via MCP request_purchase</span>
          <button type="button" className="btn-link" onClick={() => onOpen(row.request_id)}>
            Full decision trail
          </button>
        </div>
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
            Mandate check · {checks.filter((c) => c.ok).length} of {checks.length} pass
          </h3>
          <ul className="checks">
            {checks.map((c) => (
              <li key={c.key} className={c.ok ? undefined : "fail"}>
                <Icon name={c.ok ? "check" : "warn"} label={c.ok ? "Pass" : "Fail"} />
                <span>
                  {c.label}
                  {c.note && <span className="caption"> · {c.note}</span>}
                </span>
                <span className={c.ok ? "status status-ok" : "status status-warn"}>{c.ok ? "PASS" : c.key === "auto" ? "ASK" : "FAIL"}</span>
              </li>
            ))}
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
          <Activity row={row} telegram={telegram} />
        </section>
        <AskAgent row={row} onAsked={onAsked} />
      </div>

      {row.mandate && (
        <p className="mandate-strip caption" aria-label="Active mandate">
          <b>Mandate v{row.mandate.version}</b>
          <span>Monthly {usd(row.mandate.monthly_limit_cents)}</span>
          <span>Auto ≤ {usd(row.mandate.auto_approve_limit_cents)}</span>
          <span>Per purchase ≤ {row.mandate.per_tx_cap_cents == null ? "no cap" : usd(row.mandate.per_tx_cap_cents)}</span>
          <span>Allowed: {row.mandate.allowed_merchants.length ? row.mandate.allowed_merchants.join(" · ") : "any merchant"}</span>
        </p>
      )}

      <footer className="stack-s">
        {!denyOpen && (
          <div className="stack-s">
            <label className="check-row">
              <input type="checkbox" checked={alsoAllow} disabled={busy} onChange={(e) => setAlsoAllow(e.target.checked)} aria-describedby={`allow-${row.request_id}`} />
              <span>
                Also allow <b>{row.merchant}</b> automatically up to ${row.amount}
              </span>
            </label>
            <span id={`allow-${row.request_id}`} className="caption">
              Saves mandate v{(row.mandate_version ?? 0) + 1} when you approve. Caps and block list still apply.
            </span>
          </div>
        )}
        {denyOpen ? (
          <div className="stack-s" role="group" aria-label="Deny reason">
            <span className="label">Why deny? (sent to the agent)</span>
            <div className="row">
              {DENY_REASONS.map((r) => (
                <button key={r} type="button" className="chip-btn" aria-pressed={denyNote === r} onClick={() => setDenyNote(denyNote === r ? "" : r)}>
                  {r}
                </button>
              ))}
            </div>
            <label className="sr-only" htmlFor={`deny-${row.request_id}`}>
              Or write your own reason
            </label>
            <input
              id={`deny-${row.request_id}`}
              className="input"
              placeholder="Or write your own reason (optional)"
              value={DENY_REASONS.includes(denyNote) ? "" : denyNote}
              onChange={(e) => setDenyNote(e.target.value)}
              maxLength={300}
            />
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
            <button className="btn btn-primary btn-lg" disabled={busy} onClick={() => onDecide("approve", undefined, alsoAllow)}>
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
      </footer>
    </article>
  );
}

/** S5 recent decisions: who settled it (Auto / Approved / Rejected / Blocked), blocked rows stay red. */
function outcomeChip(r: LedgerRow): { label: string; className: string; bad: boolean } {
  const human = r.decisions.some((d) => d.stage === "human");
  if (r.status === "denied") return human ? { label: "Rejected", className: "status status-bad", bad: false } : { label: "Blocked", className: "status status-bad", bad: true };
  if (r.status === "paid") return human ? { label: "Approved", className: "status status-ok", bad: false } : { label: "Auto", className: "status status-ok", bad: false };
  return { ...statusChip(r), bad: false };
}

function DecisionRows({ rows, onOpen }: { rows: LedgerRow[]; onOpen: (id: string) => void }) {
  return (
    <ul className="list">
      {rows.map((r) => {
        const chip = outcomeChip(r);
        return (
          <li key={r.request_id} className={chip.bad ? "recent-bad" : undefined}>
            <button type="button" className="decided-row" onClick={() => onOpen(r.request_id)} aria-label={`${r.display_id}: ${r.agent_name}, ${r.merchant}, $${r.amount}, ${chip.label}. Open details`}>
              <span className="stack-s" style={{ gap: 0 }}>
                <span className="label">{r.agent_name}</span>
                <span className="caption">
                  {r.merchant} · {ago(r.created_at)} · <span className="mono nowrap">{r.display_id}</span>
                </span>
              </span>
              <span className="row" style={{ flexWrap: "nowrap" }}>
                <span className="num">${r.amount}</span>
                <span className={chip.className}>{chip.label}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function RecentDecisions({ rows, onOpen }: { rows: LedgerRow[] | null; onOpen: (id: string) => void }) {
  if (!rows?.length) return null;
  return (
    <section className="stack-s" aria-labelledby="recent-h">
      <h3 id="recent-h" className="section-title">Recent decisions</h3>
      <DecisionRows rows={rows.slice(0, 3)} onOpen={onOpen} />
    </section>
  );
}

type Tab = "pending" | "decided";

function Tabs({ tab, onTab, pending, decided }: { tab: Tab; onTab: (t: Tab) => void; pending: number | null; decided: number | null }) {
  const tabs: Array<{ id: Tab; label: string; n: number | null }> = [
    { id: "pending", label: "Pending", n: pending },
    { id: "decided", label: "Decided", n: decided },
  ];
  return (
    <div
      className="tabs"
      role="tablist"
      aria-label="Approvals"
      onKeyDown={(e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const next: Tab = tab === "pending" ? "decided" : "pending";
        onTab(next);
        document.getElementById(`tab-${next}`)?.focus();
      }}
    >
      {tabs.map((t) => (
        <button key={t.id} id={`tab-${t.id}`} role="tab" type="button" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} onClick={() => onTab(t.id)}>
          {t.label}
          {t.n != null && t.id === "pending" && <span className="tab-count num">{t.n}</span>}
        </button>
      ))}
    </div>
  );
}

/** S5 queue footer: this month's decision split + whether Telegram gets the same cards. */
function QueueSummary({ month, telegram }: { month: Overview["decisions"] | null; telegram: boolean | null }) {
  const segs = month
    ? [
        { key: "auto", label: "Auto", n: month.auto },
        { key: "human", label: "Human", n: month.human },
        { key: "blocked", label: "Blocked", n: month.blocked },
      ]
    : [];
  return (
    <div className="stack-s">
      {month && (
        <section className="mini-card stack-s" aria-labelledby="month-h">
          <div className="row between">
            <h3 id="month-h" className="label">
              This month
            </h3>
            <span className="caption num">
              {month.total} {month.total === 1 ? "request" : "requests"}
            </span>
          </div>
          <span className="stackbar" aria-hidden>
            {month.auto + month.human + month.blocked > 0 ? segs.filter((s) => s.n > 0).map((s) => <i key={s.key} className={`seg-${s.key}`} style={{ flexGrow: s.n }} />) : <i className="seg-none" style={{ flexGrow: 1 }} />}
          </span>
          <ul className="legend caption num" aria-label="Decision distribution this month">
            {segs.map((s) => (
              <li key={s.key}>
                <i className={`sw seg-${s.key}`} aria-hidden />
                {s.label} {s.n}
              </li>
            ))}
          </ul>
        </section>
      )}
      {telegram != null && (
        <section className="mini-card row" aria-label="Telegram">
          <span className={telegram ? "dot dot-ok" : "dot"} aria-hidden />
          <span className="stack-s" style={{ gap: 0 }}>
            <span className="label">{telegram ? "Telegram linked" : "Telegram not linked"}</span>
            <span className="caption">{telegram ? "The same cards arrive on your phone." : "Approvals work here; link Telegram in Setup to approve from your phone."}</span>
          </span>
        </section>
      )}
    </div>
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
  const [month, setMonth] = useState<Overview["decisions"] | null>(null);
  const [telegram, setTelegram] = useState<boolean | null>(null);
  const [publicDemo, setPublicDemo] = useState(false);
  const [raising, setRaising] = useState(false);
  const [tab, setTabState] = useState<Tab>(params.get("tab") === "decided" ? "decided" : "pending");
  const [drawerId, setDrawerId] = useState<string | null>(params.get("drawer") === "1" ? params.get("r") : null);

  const setTab = useCallback((t: Tab) => {
    setTabState(t);
    const u = new URL(window.location.href);
    if (t === "decided") u.searchParams.set("tab", "decided");
    else u.searchParams.delete("tab");
    window.history.replaceState(window.history.state, "", u);
  }, []);

  const load = useCallback(() => {
    api<{ items: InboxItem[] }>("/api/inbox")
      .then((r) => {
        setRows(r.items);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
    api<{ rows: LedgerRow[] }>("/api/ledger?limit=30&status=paid,denied,expired,failed,awaiting_buyer")
      .then((r) => setRecent(r.rows))
      .catch(() => setRecent(null));
    api<Overview>("/api/overview")
      .then((o) => setMonth(o.decisions))
      .catch(() => setMonth(null));
    api<{ telegram_linked: boolean; public_demo?: boolean }>("/api/workspace")
      .then((w) => {
        setTelegram(w.telegram_linked);
        setPublicDemo(Boolean(w.public_demo));
      })
      .catch(() => setTelegram(null));
  }, []);

  useEffect(load, [load]);
  useLive(load);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const selected = useMemo(() => rows?.find((r) => r.request_id === selectedId || r.display_id === selectedId) ?? rows?.[0] ?? null, [rows, selectedId]);

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

  /** Public demo only: raises the Research Scout statista request again so a visitor always has a card to approve. */
  async function raiseSample() {
    setRaising(true);
    try {
      await api("/api/demo/request", { method: "POST", body: {} });
      load();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setRaising(false);
    }
  }

  function onAsked(r: LedgerRow) {
    setNotice(`Question sent to ${r.agent_name}.`);
    load();
  }

  const showDetail = tab === "pending" && rows && rows.length > 0 && selected;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p className="muted">Purchases the rules and the auditor want you to look at. Same queue as Telegram.</p>
        </div>
        {rows && (
          <span className="caption num">
            {rows.length} pending · {rows.filter((r) => Date.now() - Date.parse(r.created_at) > OVERDUE_MS).length} overdue
          </span>
        )}
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
      ) : (
        <div className="split">
          <section className="panel panel-tight stack" aria-label="Approvals queue">
            <Tabs tab={tab} onTab={setTab} pending={rows.length} decided={recent?.length ?? null} />
            {tab === "pending" ? (
              <div id="panel-pending" role="tabpanel" aria-labelledby="tab-pending" className="stack">
                {rows.length === 0 ? (
                  <div className="empty" aria-live="polite">
                    <h2>All clear</h2>
                    <p className="muted">Nothing waiting for you. New requests appear here{telegram ? " and on Telegram" : ""} instantly.</p>
                    {publicDemo && (
                      <p>
                        <button type="button" className="btn btn-primary" onClick={raiseSample} disabled={raising}>
                          {raising ? "Sending…" : "Send a sample request"}
                        </button>
                        <span className="caption"> Research Scout asks to buy a $59 report, so you can try the approval.</span>
                      </p>
                    )}
                  </div>
                ) : (
                  <ul className="pick-list" aria-live="polite">
                    {rows.map((r) => (
                      <QueueItem key={r.request_id} row={r} selected={selected?.request_id === r.request_id} onSelect={() => setSelectedId(r.request_id)} />
                    ))}
                  </ul>
                )}
                {rows.length === 1 && (
                  <div className="mini-card row all-clear" role="status">
                    <Icon name="check" className="ico-s" />
                    <span className="stack-s" style={{ gap: 0 }}>
                      <span className="label">All clear after this one</span>
                      <span className="caption">New requests appear here{telegram ? " and on Telegram" : ""}.</span>
                    </span>
                  </div>
                )}
                <RecentDecisions rows={recent} onOpen={setDrawerId} />
                <QueueSummary month={month} telegram={telegram} />
              </div>
            ) : (
              <div id="panel-decided" role="tabpanel" aria-labelledby="tab-decided" className="stack-s">
                <p className="caption">Latest {recent?.length ?? 0} decided requests. Open one for the full decision trail.</p>
                {recent === null ? <div className="skeleton" /> : recent.length === 0 ? <p className="muted">No decisions yet.</p> : <DecisionRows rows={recent} onOpen={setDrawerId} />}
              </div>
            )}
          </section>
          {tab === "decided" && (
            <section className="panel empty-side" aria-label="Decision trail">
              <div className="empty">
                <h2>Why was it decided?</h2>
                <p className="muted">Open any decided request for its timeline, hard-rule table, risk score, mandate snapshot and the raw MCP request.</p>
              </div>
            </section>
          )}
          {showDetail && (
            <Detail
              row={selected}
              busy={busy === selected.request_id}
              telegram={Boolean(telegram)}
              onDecide={(a, n, allow) => decide(selected.request_id, a, n, allow)}
              onAsked={onAsked}
              onOpen={setDrawerId}
            />
          )}
        </div>
      )}
      {drawerId && <RequestDrawer requestId={drawerId} onClose={() => setDrawerId(null)} onChanged={load} />}
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
