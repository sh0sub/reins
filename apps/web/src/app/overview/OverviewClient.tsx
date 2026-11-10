"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { FeedItem, Overview, OverviewPeriod, WeeklySummary } from "@reins/core";
import { api } from "@/lib/api";
import { useLive } from "@/lib/live";
import { statusChip, usd } from "@/lib/format";
import { playgroundCaption } from "@/lib/shell";
import { usePending } from "@/components/Nav";
import { Icon } from "@/components/Icon";
import { RequestDrawer } from "@/components/RequestDrawer";
import { sliceHref, toSlices } from "./slices";

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
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
const envLabel = (env: string) => (env === "sandbox" ? "PayPal Sandbox" : env === "fake" ? "Sandbox demo data" : env);

const PERIODS: Array<{ id: OverviewPeriod; label: string }> = [
  { id: "month", label: "This month" },
  { id: "30d", label: "Last 30 days" },
];
/** Wording that changes with the S7 period toggle. */
function periodWords(p: OverviewPeriod) {
  return p === "30d"
    ? { lead: "Last 30 days", spent: "Spent in the last 30 days", within: "in the last 30 days", short: "last 30 days" }
    : { lead: "This month", spent: "Spent this month", within: "this month", short: "this month" };
}

function headRange(o: Overview) {
  const start = new Date(o.period.start);
  const now = new Date(o.period.now);
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const title = o.period.kind === "30d" ? "Last 30 days at a glance" : `${start.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })} at a glance`;
  return { title, range: `${fmt(start)} – ${fmt(now)} UTC` };
}

function PeriodToggle({ value, onChange }: { value: OverviewPeriod; onChange: (p: OverviewPeriod) => void }) {
  return (
    <div className="segmented" role="group" aria-label="Period">
      {PERIODS.map((p) => (
        <button key={p.id} type="button" aria-pressed={value === p.id} onClick={() => onChange(p.id)}>
          {p.label}
        </button>
      ))}
    </div>
  );
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
  const w = periodWords(o.period.kind);
  const inboxWaiting = usePending() ?? d.pending; // same count as the nav badge and /inbox
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
          {w.spent}
        </h2>
        <p className="row kpi-v">
          <span className="metric">{usd(o.totals.spent_cents)}</span>
          <span className="muted">of {usd(o.totals.limit_cents)}</span>
        </p>
        <span className={barClass(o.totals.pct)} aria-hidden>
          <i style={{ width: `${Math.min(o.totals.pct, 100)}%` }} />
        </span>
        <span className="caption num">
          {o.totals.pct}% of combined {o.period.kind === "30d" ? "monthly " : ""}caps
        </span>
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
          Only {d.human} needed your tap {w.within}
          {inboxWaiting > 0 && (
            <>
              {" · "}
              <Link href="/inbox">{inboxWaiting} waiting</Link>
            </>
          )}
        </span>
      </section>
    </div>
  );
}

/** S2 "Money protected": exposure, blocked dollars, auto-paid share and human time saved, all from the ledger. */
function Protected({ o }: { o: Overview }) {
  const p = o.protection;
  const w = periodWords(o.period.kind);
  return (
    <section className="panel panel-tight stack protect" aria-labelledby="prot-h">
      <div className="card-h">
        <h2 id="prot-h" className="h-card row">
          <Icon name="shield" className="ico" />
          Money protected
        </h2>
        <span className="caption">{p.demo_data ? "Seeded sandbox demo data, not live traffic" : "Computed from your ledger"}</span>
      </div>
      <dl className="protect-grid num">
        <div>
          <dt className="caption">Worst-case exposure</dt>
          <dd>
            <b className="metric">{usd(p.exposure_cents)}</b>
            <span className="muted"> / month</span>
          </dd>
          <dd className="caption">
            sum of {p.exposure_agents} agent caps · one shared key has no limit
          </dd>
        </div>
        <div>
          <dt className="caption">Blocked {w.within}</dt>
          <dd>
            <b className="metric">{usd(p.blocked_cents)}</b>
            <span className="muted"> in {p.blocked_count} {p.blocked_count === 1 ? "request" : "requests"}</span>
          </dd>
          <dd className="caption">
            {p.blocked_top ? (
              <Link href={`/ledger?r=${p.blocked_top.request_id}&drawer=1`}>
                {p.blocked_top.display_id} {p.blocked_top.merchant} {usd(p.blocked_top.amount_cents)}
              </Link>
            ) : (
              "nothing blocked yet"
            )}
            {p.blocked_top && p.blocked_top.rules_failed > 0 ? ` · ${p.blocked_top.rules_failed} hard ${p.blocked_top.rules_failed === 1 ? "rule" : "rules"} failed` : ""}
          </dd>
        </div>
        <div>
          <dt className="caption">Paid without a tap</dt>
          <dd>
            <b className="metric">{p.auto_paid}</b>
            <span className="muted"> of {p.requests}</span>
          </dd>
          <dd className="caption">inside the mandate and the auto-approve limit</dd>
        </div>
        <div>
          <dt className="caption">Your time saved</dt>
          <dd>
            <b className="metric">{p.minutes_saved}</b>
            <span className="muted"> min</span>
          </dd>
          <dd className="caption">(auto + blocked) x {p.seconds_per_approval} s per approval, an assumption</dd>
        </div>
      </dl>
    </section>
  );
}

function Caps({ o }: { o: Overview }) {
  const period = o.period.kind;
  return (
    <section className="panel panel-tight stack" aria-labelledby="caps-h">
      <div className="card-h">
        <h2 id="caps-h" className="h-card">
          Cap used by agent
        </h2>
        <span className="caption">{period === "30d" ? "Month to date (caps reset monthly) · select to filter the ledger" : "Select an agent to filter the ledger"}</span>
      </div>
      <ul className="caps">
        {o.agents.map((a) => (
          <li key={a.id}>
            <Link className="cap-row" href={`/ledger?agent=${a.id}&period=month`} aria-label={`${a.name}: ${usd(a.spent_cents)} of ${a.limit_cents == null ? "no cap" : usd(a.limit_cents)}, ${a.pct}% used. Open in ledger`}>
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

function Categories({ o, onSelect }: { o: Overview; onSelect: (href: string) => void }) {
  const period = o.period.kind;
  const w = periodWords(period);
  const slices = toSlices(o.categories);
  const total = slices.reduce((s, c) => s + c.cents, 0);
  return (
    <section className="panel panel-tight stack" aria-labelledby="cat-h">
      <div className="card-h">
        <h2 id="cat-h" className="h-card">
          By category
        </h2>
        <span className="caption">Select a category to filter the ledger</span>
      </div>
      {slices.length === 0 ? (
        <p className="muted">No spending {w.within} yet.</p>
      ) : (
        <div className="donut-wrap">
          <div className="donut" role="img" aria-label={`Spend by category this month, ${usd(total)} total: ${slices.map((s) => `${s.category} ${usd(s.cents)} (${pctOf(s.cents, total)}%)`).join(", ")}`}>
            <CategoryDonut slices={slices} totalCents={total} caption={w.short} onSelect={(s) => onSelect(sliceHref(s, period))} />
          </div>
          <ul className="dleg num" aria-label="Categories, paid and committed">
            {slices.map((s) => (
              <li key={s.category}>
                <Link className="dleg-row" href={sliceHref(s, period)} aria-label={`${s.category}: ${usd(s.cents)}, ${pctOf(s.cents, total)}%. Show in ledger`}>
                  <i className="sw" style={{ background: s.color }} aria-hidden />
                  <span className="dleg-name">{s.category}</span>
                  <span className="caption">{usd(s.cents)}</span>
                  <b>{pctOf(s.cents, total)}%</b>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Feed({ o, onOpen }: { o: Overview; onOpen: (id: string) => void }) {
  const w = periodWords(o.period.kind);
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
        <p className="muted">No decisions yet {w.within}.</p>
      ) : (
        <ul className="feed">
          {o.recent.map((f) => {
            const chip = feedChip(f);
            return (
              <li key={f.request_id}>
                <Link
                  className={f.outcome === "blocked" ? "feed-row bad" : "feed-row"}
                  href={`/ledger?r=${f.request_id}&drawer=1`}
                  aria-label={`${f.display_id}: ${f.agent_name}, ${f.merchant}, ${usd(f.amount_cents)}, ${chip.label}. Open details`}
                  onClick={(e) => {
                    // plain click opens the S6 drawer in place; cmd/ctrl-click keeps the ledger deep link
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    onOpen(f.request_id);
                  }}
                >
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
        {summary && <span className="caption" title={summary.source === "claude" ? undefined : `Written by Reins from your numbers. ${summary.fallback_reason ?? ""}`.trim()}>{summary.source === "claude" ? "by Claude" : "Auto summary"}</span>}
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
              <Link className="btn" href={`/ledger?r=${summary.action.request_id}&drawer=1`}>
                <Icon name="eye" className="ico" />
                Review {summary.action.display_id}
              </Link>
              <Link className="btn" href={`/agents?agent=${summary.action.agent_id}&block=${encodeURIComponent(summary.action.merchant)}${summary.action.cap_failed ? "&cap=60" : ""}`}>
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

function OverviewScreen({ initial, tryEnabled }: { initial: Overview | null; tryEnabled: boolean }) {
  const params = useSearchParams();
  const router = useRouter();
  const period: OverviewPeriod = params.get("period") === "30d" ? "30d" : "month";
  const incl = params.get("playground") === "1";
  const [o, setO] = useState<Overview | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<WeeklySummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Overview>(`/api/overview?period=${period}${incl ? "&include_playground=1" : ""}`)
      .then((r) => {
        setO(r);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [period, incl]);
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

  // the weekly summary is period-independent; only the numbers reload when the toggle changes
  const shown = o && o.period.kind === period && o.playground.included === incl ? o : null;
  const href = (p: OverviewPeriod, inc: boolean) => {
    const q = new URLSearchParams();
    if (p !== "month") q.set("period", p);
    if (inc) q.set("playground", "1");
    return q.size ? `/overview?${q}` : "/overview";
  };
  const head = shown ? headRange(shown) : null;
  const w = periodWords(period);
  const waiting = usePending() ?? 0;

  return (
    <>
      <div className="page-head ov-head">
        <div>
          <h1>{head ? head.title : "Overview"}</h1>
          {/* one sub-line: the figures once loaded, the product line while loading or empty */}
          <p className="muted ov-sub">
            {shown && head && shown.totals.agents > 0
              ? `${w.lead} ${usd(shown.totals.spent_cents)} of ${usd(shown.totals.limit_cents)} across ${shown.totals.agents} ${shown.totals.agents === 1 ? "agent" : "agents"} · ${head.range} · ${envLabel(shown.paypal_env)}`
              : "Hold the reins on AI spending. Every agent purchase checked against its mandate, then approved, paid or blocked."}
          </p>
        </div>
        <div className="row ov-tools">
          {waiting > 0 && (
            <Link className="btn btn-primary" href={"/inbox"}>
              Review {waiting} waiting
            </Link>
          )}
          {shown && (shown.playground.requests > 0 || shown.playground.included) && (
            <label className="try-toggle ov-play" title={playgroundCaption(shown.playground.requests, incl)}>
              <input type="checkbox" checked={incl} onChange={(e) => router.replace(href(period, e.target.checked), { scroll: false })} aria-describedby="ov-play-cap" />
              <span>
                <b>Include playground requests</b>
                <span className="caption" id="ov-play-cap">
                  {playgroundCaption(shown.playground.requests, incl)}
                </span>
              </span>
            </label>
          )}
          {tryEnabled && (
            <Link className="btn" href="/try">
              <Icon name="bot" className="ico" />
              Try an agent
            </Link>
          )}
          {shown && shown.totals.agents > 0 && <StatusChip status={shown.status} />}
          <PeriodToggle value={period} onChange={(p) => router.replace(href(p, incl), { scroll: false })} />
        </div>
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
      ) : !shown ? (
        <Loading />
      ) : shown.totals.agents === 0 ? (
        <div className="empty">
          <h2>Your agents haven&apos;t spent anything yet.</h2>
          <p className="muted">Add an agent, give it a mandate, and its spending, decisions and caps show up here.</p>
          <Link className="btn btn-primary" href="/agents">
            Add an agent
          </Link>
        </div>
      ) : (
        <div className="stack-l">
          <Kpis o={shown} />
          <Protected o={shown} />
          <div className="ov-mid">
            <Caps o={shown} />
            <Categories o={shown} onSelect={(href) => router.push(href)} />
          </div>
          <div className="ov-bot">
            <Feed o={shown} onOpen={setDrawerId} />
            <WeeklyCard summary={summary} error={summaryError} onRetry={loadSummary} />
          </div>
        </div>
      )}
      {drawerId && <RequestDrawer requestId={drawerId} onClose={() => setDrawerId(null)} onChanged={load} />}
    </>
  );
}

export default function OverviewClient({ initial, tryEnabled = false }: { initial: Overview | null; tryEnabled?: boolean }) {
  return (
    <Suspense fallback={<Loading />}>
      <OverviewScreen initial={initial} tryEnabled={tryEnabled} />
    </Suspense>
  );
}
