"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { FeedItem, Overview, WeeklySummary } from "@reins/core";
import { api } from "@/lib/api";
import { useLive } from "@/lib/live";
import { statusChip, usd } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { toSlices } from "./slices";

// AG Charts touches window: client only.
const CategoryDonut = dynamic(() => import("./CategoryDonut").then((m) => m.CategoryDonut), { ssr: false, loading: () => <div className="skeleton donut-skeleton" /> });

const initials = (name: string) =>
  name
    .split(/[\s–-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

const pctOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const barClass = (pct: number) => (pct >= 100 ? "bar bad" : pct >= 80 ? "bar warn" : "bar");
/** "8 min ago" today, otherwise "Oct 23" (English, like the rest of the page). */
function when(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
const envLabel = (env: string) => (env === "sandbox" ? "PayPal Sandbox" : env === "fake" ? "Fake PayPal (offline)" : env);

function monthRange(o: Overview) {
  const start = new Date(o.period.month_start);
  const now = new Date(o.period.now);
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return { month: start.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }), range: `${fmt(start)} – ${fmt(now)}` };
}

function feedChip(f: FeedItem) {
  if (f.status === "denied") return f.outcome === "blocked" ? { label: "Blocked", className: "status status-bad" } : { label: "Rejected", className: "status status-bad" };
  return statusChip(f);
}

function StatusChip({ status }: { status: Overview["status"] }) {
  const cls = status.level === "ok" ? "status status-ok" : status.level === "warn" ? "status status-warn" : "status status-bad";
  return (
    <span className={`${cls} status-lg`} role="status">
      <Icon name={status.level === "ok" ? "shield" : "warn"} className="ico" />
      {status.message}
    </span>
  );
}

function Kpis({ o }: { o: Overview }) {
  const d = o.decisions;
  const segs = [
    { key: "auto", label: "Auto", n: d.auto },
    { key: "human", label: "Human", n: d.human },
    { key: "blocked", label: "Blocked", n: d.blocked },
  ];
  const decided = d.auto + d.human + d.blocked;
  return (
    <div className="kpis kpis-3">
      <section className="panel panel-tight stack-s" aria-labelledby="kpi-spent">
        <h2 id="kpi-spent" className="caption kpi-k">
          Spent this month
        </h2>
        <p className="row kpi-v">
          <span className="metric">{usd(o.totals.spent_cents)}</span>
          <span className="muted">of {usd(o.totals.limit_cents)}</span>
        </p>
        <span className={barClass(o.totals.pct)} aria-hidden>
          <i style={{ width: `${Math.min(o.totals.pct, 100)}%` }} />
        </span>
        <span className="caption num">{o.totals.pct}% of combined caps</span>
      </section>

      <section className="panel panel-tight stack-s" aria-labelledby="kpi-dec">
        <h2 id="kpi-dec" className="caption kpi-k">
          Decisions
        </h2>
        <p className="row kpi-v">
          <span className="metric">{d.total}</span>
          <span className="muted">{d.total === 1 ? "request" : "requests"}</span>
        </p>
        <span className="stackbar" aria-hidden>
          {decided > 0 ? segs.filter((s) => s.n > 0).map((s) => <i key={s.key} className={`seg-${s.key}`} style={{ flexGrow: s.n }} />) : <i className="seg-none" style={{ flexGrow: 1 }} />}
        </span>
        <ul className="legend caption num" aria-label="Decision distribution">
          {segs.map((s) => (
            <li key={s.key}>
              <i className={`sw seg-${s.key}`} aria-hidden />
              {s.label} {s.n}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel panel-tight stack-s" aria-labelledby="kpi-saved">
        <h2 id="kpi-saved" className="caption kpi-k">
          Saved you
        </h2>
        <p className="row kpi-v">
          <span className="metric">{o.approvals_saved}</span>
          <span className="muted">{o.approvals_saved === 1 ? "approval" : "approvals"}</span>
        </p>
        <span className="row caption ok-line">
          <Icon name="check" className="ico-s" />
          vs. approving every request by hand
        </span>
        <span className="caption">
          Only {d.human} needed your tap this month
          {d.pending > 0 && (
            <>
              {" · "}
              <Link href="/inbox">{d.pending} waiting</Link>
            </>
          )}
        </span>
      </section>
    </div>
  );
}

function Caps({ o }: { o: Overview }) {
  return (
    <section className="panel panel-tight stack" aria-labelledby="caps-h">
      <div className="card-h">
        <h2 id="caps-h" className="h-card">
          Cap used by agent
        </h2>
        <span className="caption">Select an agent to filter the ledger</span>
      </div>
      <ul className="caps">
        {o.agents.map((a) => (
          <li key={a.id}>
            <Link className="cap-row" href={`/ledger?agent=${a.id}`} aria-label={`${a.name}: ${usd(a.spent_cents)} of ${a.limit_cents == null ? "no cap" : usd(a.limit_cents)}, ${a.pct}% used. Open in ledger`}>
              <span className="row cap-top">
                <span className="status status-info" aria-hidden>
                  {initials(a.name)}
                </span>
                <span className="label cap-name">{a.name}</span>
                <span className="caption num cap-amt">{a.limit_cents == null ? `${usd(a.spent_cents)} · no mandate` : `${usd(a.spent_cents)} / ${usd(a.limit_cents)}`}</span>
                <b className="num cap-pct">{a.pct}%</b>
              </span>
              <span className={barClass(a.pct)} aria-hidden>
                <i style={{ width: `${Math.min(a.pct, 100)}%` }} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Categories({ o }: { o: Overview }) {
  const slices = toSlices(o.categories);
  const total = slices.reduce((s, c) => s + c.cents, 0);
  return (
    <section className="panel panel-tight stack" aria-labelledby="cat-h">
      <div className="card-h">
        <h2 id="cat-h" className="h-card">
          By category
        </h2>
        <span className="caption">Paid and committed</span>
      </div>
      {slices.length === 0 ? (
        <p className="muted">No spending this month yet.</p>
      ) : (
        <div className="donut-wrap">
          <div className="donut" role="img" aria-label={`Spend by category this month, ${usd(total)} total: ${slices.map((s) => `${s.category} ${usd(s.cents)} (${pctOf(s.cents, total)}%)`).join(", ")}`}>
            <CategoryDonut slices={slices} totalCents={total} />
          </div>
          <ul className="dleg num">
            {slices.map((s) => (
              <li key={s.category}>
                <i className="sw" style={{ background: s.color }} aria-hidden />
                <span className="dleg-name">{s.category}</span>
                <span className="caption">{usd(s.cents)}</span>
                <b>{pctOf(s.cents, total)}%</b>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Feed({ o }: { o: Overview }) {
  return (
    <section className="panel panel-tight stack" aria-labelledby="feed-h">
      <div className="card-h">
        <h2 id="feed-h" className="h-card">
          Recent decisions
        </h2>
        <Link className="link-48" href="/ledger">
          Open ledger
          <Icon name="arrow" className="ico-s" />
        </Link>
      </div>
      {o.recent.length === 0 ? (
        <p className="muted">No decisions yet this month.</p>
      ) : (
        <ul className="feed">
          {o.recent.map((f) => {
            const chip = feedChip(f);
            return (
              <li key={f.request_id}>
                <Link className={f.outcome === "blocked" ? "feed-row bad" : "feed-row"} href={`/ledger?r=${f.request_id}`}>
                  <span className={chip.className}>{chip.label}</span>
                  <span className="feed-main">
                    <span>
                      <b>{f.agent_name}</b> · {f.merchant}
                    </span>
                    <span className="caption">
                      {f.display_id} · {f.via}
                    </span>
                  </span>
                  <b className="num feed-amt">{usd(f.amount_cents)}</b>
                  <span className="caption num feed-time">{when(f.created_at)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function WeeklyCard({ summary, error, onRetry }: { summary: WeeklySummary | null; error: string | null; onRetry: () => void }) {
  return (
    <section className="panel panel-tight stack weekly" aria-labelledby="wk-h" aria-busy={!summary && !error}>
      <div className="card-h">
        <h2 id="wk-h" className="h-card row">
          <Icon name="sparkle" className="ico" />
          AI weekly summary
        </h2>
        {summary && <span className="caption">{summary.source === "claude" ? "by Claude" : `Template · ${summary.fallback_reason ?? "Claude unavailable"}`}</span>}
      </div>
      {error ? (
        <div className="stack-s">
          <p className="muted">The weekly summary is unavailable right now.</p>
          <div>
            <button className="btn" onClick={onRetry}>
              Retry
            </button>
          </div>
        </div>
      ) : !summary ? (
        <div className="stack-s" aria-label="Writing the weekly summary">
          <div className="skeleton" style={{ minHeight: 48 }} />
          <div className="skeleton" style={{ minHeight: 56 }} />
        </div>
      ) : (
        <>
          <p className="wk-text">{summary.summary}</p>
          <dl className="wk-stats num">
            <div>
              <dt className="caption">spent this week</dt>
              <dd>{usd(summary.stats.week_spent_cents)}</dd>
            </div>
            <div>
              <dt className="caption">purchases</dt>
              <dd>{summary.stats.week_purchases}</dd>
            </div>
            {summary.stats.top_agent && (
              <div>
                <dt className="caption">{summary.stats.top_agent.name} cap used</dt>
                <dd>{summary.stats.top_agent.pct}%</dd>
              </div>
            )}
          </dl>
          {summary.warning && (
            <div className="alert row wk-warn" role="note">
              <Icon name="warn" className="ico" />
              <p>{summary.warning}</p>
            </div>
          )}
          {summary.action && (
            <div className="row">
              <Link className="btn" href={`/ledger?r=${summary.action.request_id}`}>
                <Icon name="eye" className="ico" />
                Review {summary.action.display_id}
              </Link>
              <Link className="btn" href={`/agents?agent=${summary.action.agent_id}&block=${encodeURIComponent(summary.action.merchant)}`}>
                <Icon name="edit" className="ico" />
                Tighten mandate
              </Link>
            </div>
          )}
          <p className="caption">Week of {new Date(`${summary.week_start}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} · from totals only, no keys or PayPal ids.</p>
        </>
      )}
    </section>
  );
}

function Loading() {
  return (
    <div className="stack-l" aria-busy="true" aria-label="Loading overview">
      <div className="kpis kpis-3">
        <div className="skeleton" style={{ minHeight: 132 }} />
        <div className="skeleton" style={{ minHeight: 132 }} />
        <div className="skeleton" style={{ minHeight: 132 }} />
      </div>
      <div className="ov-mid">
        <div className="skeleton" style={{ minHeight: 240 }} />
        <div className="skeleton" style={{ minHeight: 240 }} />
      </div>
    </div>
  );
}

export default function OverviewPage() {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<WeeklySummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    api<Overview>("/api/overview")
      .then((r) => {
        setO(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  // The summary may call Claude: fetched separately so it never blocks the numbers.
  const loadSummary = useCallback(() => {
    setSummaryError(null);
    api<WeeklySummary>("/api/overview/summary")
      .then(setSummary)
      .catch((e: Error) => setSummaryError(e.message));
  }, []);
  useEffect(() => {
    load();
    loadSummary();
  }, [load, loadSummary]);
  useLive(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      load();
      loadSummary();
    }, 500);
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const head = o ? monthRange(o) : null;

  return (
    <>
      <div className="page-head ov-head">
        <div>
          <h1>{head ? `${head.month} at a glance` : "Overview"}</h1>
          {o && head && (
            <p className="muted">
              This month {usd(o.totals.spent_cents)} of {usd(o.totals.limit_cents)} across {o.totals.agents} {o.totals.agents === 1 ? "agent" : "agents"} · {head.range} · {envLabel(o.paypal_env)}
            </p>
          )}
        </div>
        {o && o.totals.agents > 0 && <StatusChip status={o.status} />}
      </div>

      {error ? (
        <div className="panel stack">
          <p className="alert alert-bad" role="alert">
            Could not load the overview: {error}
          </p>
          <div>
            <button className="btn" onClick={load}>
              Retry
            </button>
          </div>
        </div>
      ) : !o ? (
        <Loading />
      ) : o.totals.agents === 0 ? (
        <div className="empty">
          <h2>Your agents haven&apos;t spent anything yet.</h2>
          <p className="muted">Add an agent, give it a mandate, and its spending, decisions and caps show up here.</p>
          <Link className="btn btn-primary" href="/agents">
            Add an agent
          </Link>
        </div>
      ) : (
        <div className="stack-l">
          <Kpis o={o} />
          <div className="ov-mid">
            <Caps o={o} />
            <Categories o={o} />
          </div>
          <div className="ov-bot">
            <Feed o={o} />
            <WeeklyCard summary={summary} error={summaryError} onRetry={loadSummary} />
          </div>
        </div>
      )}
    </>
  );
}
