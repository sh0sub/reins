"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import type { GridApi } from "ag-grid-community";
import type { LedgerRow } from "@reins/core";
import { api } from "@/lib/api";
import { useLive } from "@/lib/live";
import { bucketTotal, outcomeBucket, resolveRequestId } from "@/lib/format";
import { agentsKpi, type ShellAgent } from "@/lib/shell";
import { RequestDrawer } from "@/components/RequestDrawer";

// AG Grid / AG Charts touch window: client only.
const LedgerGrid = dynamic(() => import("./LedgerGrid").then((m) => m.LedgerGrid), { ssr: false, loading: () => <div className="skeleton" style={{ minHeight: 420 }} /> });
const SpendChart = dynamic(() => import("./SpendChart").then((m) => m.SpendChart), { ssr: false, loading: () => <div className="skeleton" style={{ minHeight: 220 }} /> });

const STATUS_FILTERS: Array<{ id: string; label: string; match: (r: LedgerRow) => boolean }> = [
  { id: "any", label: "Any status", match: () => true },
  { id: "paid", label: "Paid", match: (r) => r.status === "paid" },
  { id: "blocked", label: "Denied", match: (r) => r.status === "denied" },
  { id: "open", label: "Open", match: (r) => ["pending_human", "awaiting_buyer", "paying", "approved"].includes(r.status) },
];

type Period = "month" | "30d" | "all";
const PERIODS: Array<{ id: Period; label: string }> = [
  { id: "month", label: "This month" },
  { id: "30d", label: "Last 30 days" },
  { id: "all", label: "All time" },
];
function periodStart(p: Period, now = new Date()): number {
  if (p === "month") return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  if (p === "30d") return now.getTime() - 30 * 86_400_000;
  return 0;
}
const catOf = (r: LedgerRow) => r.category ?? "uncategorized";
const money = (n: number) => `$${n.toFixed(2)}`;

function LedgerScreen() {
  const params = useSearchParams();
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roster, setRoster] = useState<ShellAgent[] | null>(null);
  const [agent, setAgent] = useState<string>(() => params.get("agent") ?? "all");
  // month to date like the overview; a deep link to one request (?r=) opens all time so the row is never filtered out
  const [period, setPeriod] = useState<Period>(() => {
    const p = params.get("period");
    return p === "month" || p === "30d" || p === "all" ? p : params.get("r") ? "all" : "month";
  });
  // S7 donut slice -> ?category=research (or several for "Other")
  const [categories, setCategories] = useState<string[]>(() => params.get("category")?.split(",").filter(Boolean) ?? []);
  const [status, setStatus] = useState("any");
  const [group, setGroup] = useState(true);
  const [q, setQ] = useState("");
  const [sync, setSync] = useState<{ busy: boolean; msg: string | null; bad?: boolean }>({ busy: false, msg: null });
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

  const resolveId = useCallback((id: string | null) => resolveRequestId(rows, id), [rows]);
  const drawerReqId = resolveId(drawerId);
  const focusReqId = resolveId(params.get("r"));
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
      const r = await api<{ transactions: number; checked: number; matched: number; mismatch: number; pending: number }>("/api/reconcile", { method: "POST", body: { days: 31 } });
      setSync({ busy: false, msg: `Transaction Search: ${r.transactions} PayPal transactions · ${r.matched} matched · ${r.mismatch} mismatch · ${r.pending} not listed yet` });
      load();
    } catch (e) {
      setSync({ busy: false, bad: true, msg: (e as Error).message });
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
          <button className="btn" onClick={() => gridApi.current?.exportDataAsCsv({ fileName: "reins-ledger.csv" })} disabled={!rows?.length}>
            Export CSV
          </button>
        </div>
      </div>

      {sync.msg && (
        <p className={sync.bad ? "alert alert-bad" : "alert alert-ok"} role="status" style={{ marginBottom: 16 }}>
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
                <span className="metric">${kpi.paid.toFixed(2)}</span>
                <span className="caption">
                  {kpi.matched} of {kpi.paidCount} reconciled with Transaction Search
                </span>
              </div>
              <div className="panel panel-tight stack-s">
                <span className="caption">Blocked</span>
                <span className="metric">${kpi.blocked.toFixed(2)}</span>
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
                <span className="metric">{roster ? agentsKpi(roster).total : "–"}</span>
                <span className="caption">{roster ? agentsKpi(roster).line : "Loading…"}</span>
              </div>
          </div>

          <section className="panel panel-tight stack" aria-label="Transactions">
            <div className="row between">
              <div className="row" role="group" aria-label="Agent filter">
                <button className="chip-btn" aria-pressed={agent === "all"} onClick={() => setAgent("all")}>
                  All agents
                </button>
                {agents.map(([id, name]) => (
                  <button key={id} className="chip-btn" aria-pressed={agent === id} onClick={() => setAgent(id)}>
                    {name}
                  </button>
                ))}
              </div>
              <div className="row">
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
                <input id="ledger-q" className="input" style={{ width: 200 }} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
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
              <div className="skeleton" style={{ minHeight: 420 }} aria-label="Loading transactions" />
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
