"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import type { GridApi } from "ag-grid-community";
import type { LedgerRow } from "@reins/core";
import { api } from "@/lib/api";
import { useLive } from "@/lib/live";
import { bucketTotal, isUnknownRequest, outcomeBucket, reconcileBanner, resolveRequestId, usdAmount, type BannerTone, type ReconcileResponse } from "@/lib/format";
import { agentsKpi, sidebarAgents, type ShellAgent } from "@/lib/shell";
import { useIncludePlayground } from "@/components/ShellData";
import { RequestDrawer } from "@/components/RequestDrawer";
import { LedgerSkeleton } from "./LedgerSkeleton";

// AG Grid / AG Charts touch window: client only.
const LedgerGrid = dynamic(() => import("./LedgerGrid").then((m) => m.LedgerGrid), { ssr: false, loading: () => <LedgerSkeleton /> });
const SpendChart = dynamic(() => import("./SpendChart").then((m) => m.SpendChart), { ssr: false, loading: () => <div className="skeleton" style={{ minHeight: 220 }} /> });

const STATUS_FILTERS: Array<{ id: string; label: string; match: (r: LedgerRow) => boolean }> = [
  { id: "any", label: "Any status", match: () => true },
  { id: "paid", label: "Paid", match: (r) => r.status === "paid" },
  { id: "blocked", label: "Denied", match: (r) => r.status === "denied" },
  { id: "human", label: "Needs human", match: (r) => r.status === "pending_human" },
  { id: "open", label: "Open", match: (r) => ["pending_human", "awaiting_buyer", "paying", "approved"].includes(r.status) },
];

type Period = "week" | "month" | "30d" | "all";
const PERIODS: Array<{ id: Period; label: string }> = [
  { id: "week", label: "Last 7 days" },
  { id: "month", label: "This month" },
  { id: "30d", label: "Last 30 days" },
  { id: "all", label: "All time" },
];
function periodStart(p: Period, now = new Date()): number {
  if (p === "week") return now.getTime() - 7 * 86_400_000;
  if (p === "month") return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  if (p === "30d") return now.getTime() - 30 * 86_400_000;
  return 0;
}
/** Saved views: one pick sets the status and period filters (and clears agent and category). Kept in the URL as ?view=, so a view is a link. */
const VIEWS: Array<{ id: string; label: string; status: string; period: Period }> = [
  { id: "all", label: "All activity", status: "any", period: "month" },
  { id: "blocked", label: "Blocked", status: "blocked", period: "all" },
  { id: "needs_human", label: "Needs human", status: "human", period: "all" },
  { id: "paid_week", label: "Paid this week", status: "paid", period: "week" },
];
const catOf = (r: LedgerRow) => r.category ?? "uncategorized";
const money = usdAmount;

function LedgerScreen() {
  const params = useSearchParams();
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roster, setRoster] = useState<ShellAgent[] | null>(null);
  // same agents as the sidebar: the /try Playground Agent only counts while the playground toggle is on
  const includePlayground = useIncludePlayground();
  const agentKpi = useMemo(() => (roster ? agentsKpi(sidebarAgents(roster, includePlayground)) : null), [roster, includePlayground]);
  const startView = VIEWS.find((v) => v.id === params.get("view"));
  const [agent, setAgent] = useState<string>(() => params.get("agent") ?? "all");
  // month to date like the overview; a deep link to one request (?r=) opens all time so the row is never filtered out
  const [period, setPeriod] = useState<Period>(() => {
    const p = params.get("period");
    return p === "week" || p === "month" || p === "30d" || p === "all" ? p : startView ? startView.period : params.get("r") ? "all" : "month";
  });
  // S7 donut slice -> ?category=research (or several for "Other")
  const [categories, setCategories] = useState<string[]>(() => params.get("category")?.split(",").filter(Boolean) ?? []);
  const [status, setStatus] = useState(startView?.status ?? "any");
  const [group, setGroup] = useState(true);
  const [q, setQ] = useState("");
  const [sync, setSync] = useState<{ busy: boolean; msg: string | null; tone?: BannerTone }>({ busy: false, msg: null });
  const [flash, setFlash] = useState<string | null>(null);
  const gridApi = useRef<GridApi<LedgerRow> | null>(null);
  // S6 drawer, deep link /ledger?r=<id>&drawer=1
  // r may be a display id (R-0143); it resolves to the internal id once the rows are loaded
  const [drawerId, setDrawerId] = useState<string | null>(() => (params.get("drawer") === "1" ? params.get("r") : null));
  const openDrawer = useCallback((id: string) => {
    setDrawerId(id);
    const u = new URL(window.location.href);
    u.searchParams.set("r", id);
    u.searchParams.set("drawer", "1");
    window.history.replaceState(window.history.state, "", u);
  }, []);
  const closeDrawer = useCallback(() => {
    setDrawerId(null);
    const u = new URL(window.location.href);
    u.searchParams.delete("drawer");
    window.history.replaceState(window.history.state, "", u);
  }, []);

  const load = useCallback(() => {
    api<{ rows: LedgerRow[] }>("/api/ledger?limit=500")
      .then((r) => {
        setRows(r.rows);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  const loadRoster = useCallback(() => {
    api<{ agents: ShellAgent[] }>("/api/agents").then((r) => setRoster(r.agents)).catch(() => setRoster(null));
  }, []);
  useEffect(load, [load]);
  useEffect(loadRoster, [loadRoster]);
  useLive((e) => {
    load();
    loadRoster();
    if (e.type === "request.updated" && e.request?.status === "paid") setFlash(`New row · ${e.request.display_id} paid`);
  });
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  const currentView = categories.length === 0 && agent === "all" ? VIEWS.find((v) => v.status === status && v.period === period)?.id ?? "custom" : "custom";
  function pickView(id: string) {
    const v = VIEWS.find((x) => x.id === id);
    if (!v) return;
    setStatus(v.status);
    setPeriod(v.period);
    setAgent("all");
    setCategories([]);
  }
  // keep ?view= in the address bar in step with the filters (without adding history entries)
  useEffect(() => {
    const u = new URL(window.location.href);
    if (currentView === "all" || currentView === "custom") u.searchParams.delete("view");
    else u.searchParams.set("view", currentView);
    if (u.href !== window.location.href) window.history.replaceState(window.history.state, "", u);
  }, [currentView]);

  async function downloadCsv() {
    const grid = gridApi.current;
    if (grid) (await import("./LedgerGrid")).exportAccountingCsv(grid);
  }

  const resolveId = useCallback((id: string | null) => resolveRequestId(rows, id), [rows]);
  const drawerReqId = resolveId(drawerId);
  const focusReqId = resolveId(params.get("r"));
  const missingId = isUnknownRequest(rows, params.get("r")) ? params.get("r") : null;
  const agents = useMemo(() => [...new Map((rows ?? []).map((r) => [r.agent_id, r.agent_name])).entries()], [rows]);
  // period + category scope the KPIs, the chart and the grid; agent/status/search narrow the grid only
  const scoped = useMemo(() => {
    const since = periodStart(period);
    return (rows ?? []).filter((r) => Date.parse(r.created_at) >= since && (categories.length === 0 || categories.includes(catOf(r))));
  }, [rows, period, categories]);
  const filtered = useMemo(() => {
    const f = STATUS_FILTERS.find((s) => s.id === status) ?? STATUS_FILTERS[0]!;
    return scoped.filter((r) => (agent === "all" || r.agent_id === agent) && f.match(r));
  }, [scoped, agent, status]);
  const shownTotals = useMemo(
    () => ({
      paid: filtered.filter((r) => r.status === "paid").reduce((s, r) => s + Number(r.amount), 0),
      // same definition as the Blocked tile: rule/auditor blocks only, a human "Deny" is not counted
      blocked: bucketTotal(filtered, "blocked"),
    }),
    [filtered],
  );

  const kpi = useMemo(() => {
    const all = scoped;
    const paid = all.filter((r) => r.status === "paid");
    const denied = all.filter((r) => outcomeBucket(r) === "blocked");
    const sum = (xs: LedgerRow[]) => xs.reduce((s, r) => s + Number(r.amount), 0);
    const by = (d: string) => all.filter((r) => outcomeBucket(r) === d).length;
    return {
      paid: sum(paid),
      matched: paid.filter((r) => r.payment?.reconciled === "matched").length,
      paidCount: paid.length,
      blocked: bucketTotal(denied, "blocked"),
      blockedCount: denied.length,
      total: all.length,
      auto: by("auto"),
      human: by("human"),
      denied: by("blocked"),
    };
  }, [scoped]);
  const periodLabel = PERIODS.find((p) => p.id === period)!.label.toLowerCase();

  async function reconcile() {
    setSync({ busy: true, msg: null });
    try {
      const r = await api<ReconcileResponse>("/api/reconcile", { method: "POST", body: { days: 31 } });
      setSync({ busy: false, ...reconcileBanner(r) });
      if (r.mode !== "simulated") load();
    } catch (e) {
      setSync({ busy: false, tone: "bad", msg: (e as Error).message });
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Ledger</h1>
          <p className="muted">Every request, decision and PayPal payment, reconciled with Transaction Search.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={reconcile} disabled={sync.busy}>
            {sync.busy ? "Syncing…" : "Reconcile now"}
          </button>
          <button className="btn" onClick={() => void downloadCsv()} disabled={!rows?.length} title="Exports the rows the filters leave (or only the ticked rows) with the AG Grid CSV export">
            Download CSV for accounting
          </button>
        </div>
      </div>

      {missingId && (
        <p className="alert alert-bad" role="alert" style={{ marginBottom: 16 }}>
          Request {missingId.toUpperCase()} not found. It may be mistyped or from another workspace; showing the full ledger instead.
        </p>
      )}

      {sync.msg && (
        <p className={`alert alert-${sync.tone ?? "info"}`} role="status" style={{ marginBottom: 16 }}>
          {sync.msg}
        </p>
      )}

      {error ? (
        <div className="panel stack">
          <p className="alert alert-bad" role="alert">
            Could not load the ledger: {error}
          </p>
          <div>
            <button className="btn" onClick={load}>
              Retry
            </button>
          </div>
        </div>
      ) : (
        <div className="stack-l">
          <div className="kpis kpis-4">
              <div className="panel panel-tight stack-s">
                <span className="caption">Paid</span>
                <span className="metric">{usdAmount(kpi.paid)}</span>
                <span className="caption">
                  {kpi.matched} of {kpi.paidCount} reconciled with Transaction Search
                </span>
              </div>
              <div className="panel panel-tight stack-s">
                <span className="caption">Blocked</span>
                <span className="metric">{usdAmount(kpi.blocked)}</span>
                <span className="caption">
                  {kpi.blockedCount} {kpi.blockedCount === 1 ? "request" : "requests"} · nothing charged
                </span>
              </div>
              <div className="panel panel-tight stack-s">
                <span className="caption">Requests</span>
                <span className="metric">{kpi.total}</span>
                <span className="caption">
                  Auto {kpi.auto} · Human {kpi.human} · Blocked {kpi.denied}
                </span>
              </div>
              <div className="panel panel-tight stack-s">
                <span className="caption">Agents</span>
                <span className="metric">{agentKpi ? agentKpi.total : "–"}</span>
                <span className="caption">{agentKpi ? agentKpi.line : "Loading…"}</span>
              </div>
          </div>

          <section className="panel panel-tight stack" aria-label="Transactions">
            <div className="row between">
              <div className="row ledger-f-agents" role="group" aria-label="Agent filter">
                <button className="chip-btn" aria-pressed={agent === "all"} onClick={() => setAgent("all")}>
                  All agents
                </button>
                {agents.map(([id, name]) => (
                  <button key={id} className="chip-btn" aria-pressed={agent === id} onClick={() => setAgent(id)}>
                    {name}
                  </button>
                ))}
              </div>
              <div className="row ledger-f-ctl">
                <label className="sr-only" htmlFor="view-f">Saved view</label>
                <select id="view-f" className="input" style={{ width: "auto" }} value={currentView} onChange={(e) => pickView(e.target.value)}>
                  {VIEWS.map((v) => (
                    <option key={v.id} value={v.id}>
                      View: {v.label}
                    </option>
                  ))}
                  {currentView === "custom" && <option value="custom">View: Custom filters</option>}
                </select>
                <label className="sr-only" htmlFor="period-f">Period</label>
                <select id="period-f" className="input" style={{ width: "auto" }} value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
                  {PERIODS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <label className="sr-only" htmlFor="status-f">Status</label>
                <select id="status-f" className="input" style={{ width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value)}>
                  {STATUS_FILTERS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <button className="chip-btn" aria-pressed={group} onClick={() => setGroup((g) => !g)}>
                  Group by agent
                </button>
                <label className="sr-only" htmlFor="ledger-q">Search</label>
                <input id="ledger-q" className="input ledger-q" style={{ width: 200 }} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            </div>
            {categories.length > 0 && (
              <div className="row" role="group" aria-label="Active filters">
                <span className="caption">Category</span>
                <button type="button" className="chip-btn chip-48" aria-pressed="true" aria-label={`Remove category filter ${categories.join(", ")}`} onClick={() => setCategories([])}>
                  <span className="cap-first">{categories.join(", ")}</span> ×
                </button>
              </div>
            )}
            {rows === null ? (
              <LedgerSkeleton label="Loading transactions" />
            ) : rows.length === 0 ? (
              <div className="empty">
                <h2>No activity yet</h2>
                <p className="muted">Connect an agent (Agents) and its purchase requests appear here in real time.</p>
              </div>
            ) : filtered.length === 0 && !q ? (
              <div className="empty">
                <h2>No requests match these filters</h2>
                <p className="muted">Nothing in {periodLabel} for this agent, status or category.</p>
                <button
                  className="btn"
                  onClick={() => {
                    setPeriod("all");
                    setCategories([]);
                    setAgent("all");
                    setStatus("any");
                  }}
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <LedgerGrid key={group ? "g" : "f"} rows={filtered} group={group} quickFilter={q} focusId={focusReqId} onApi={(a) => (gridApi.current = a)} onOpen={openDrawer} />
            )}
            <p className="caption">
              {filtered.length} of {scoped.length} rows ({periodLabel}) · {money(shownTotals.paid)} paid · {money(shownTotals.blocked)} blocked · expand a row for the auditor reason, mandate
              version, capture id and reconciliation; open an ID for the full decision trail.
            </p>
          </section>

          <section className="panel panel-tight stack-s" aria-labelledby="chart-h">
            <h2 id="chart-h" className="section-title">
              Paid by agent
            </h2>
            {rows ? <SpendChart rows={scoped} /> : <div className="skeleton" style={{ minHeight: 220 }} />}
          </section>
        </div>
      )}
      {drawerReqId && <RequestDrawer requestId={drawerReqId} onClose={closeDrawer} onChanged={load} />}
      {flash && (
        <div className="toast" role="status">
          {flash}
        </div>
      )}
    </>
  );
}

export default function LedgerPage() {
  return (
    <Suspense fallback={<div className="skeleton" aria-label="Loading ledger" />}>
      <LedgerScreen />
    </Suspense>
  );
}
