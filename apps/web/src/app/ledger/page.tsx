"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import type { GridApi } from "ag-grid-community";
import type { LedgerRow } from "@reins/core";
import { api } from "@/lib/api";
import { useLive } from "@/lib/live";
import { decisionLabel } from "@/lib/format";

// AG Grid / AG Charts touch window: client only.
const LedgerGrid = dynamic(() => import("./LedgerGrid").then((m) => m.LedgerGrid), { ssr: false, loading: () => <div className="skeleton" style={{ minHeight: 420 }} /> });
const SpendChart = dynamic(() => import("./SpendChart").then((m) => m.SpendChart), { ssr: false, loading: () => <div className="skeleton" style={{ minHeight: 220 }} /> });

const STATUS_FILTERS: Array<{ id: string; label: string; match: (r: LedgerRow) => boolean }> = [
  { id: "any", label: "Any status", match: () => true },
  { id: "paid", label: "Paid", match: (r) => r.status === "paid" },
  { id: "blocked", label: "Denied", match: (r) => r.status === "denied" },
  { id: "open", label: "Open", match: (r) => ["pending_human", "awaiting_buyer", "paying", "approved"].includes(r.status) },
];

function LedgerScreen() {
  const params = useSearchParams();
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState<string>("all");
  const [status, setStatus] = useState("any");
  const [group, setGroup] = useState(true);
  const [q, setQ] = useState("");
  const [sync, setSync] = useState<{ busy: boolean; msg: string | null; bad?: boolean }>({ busy: false, msg: null });
  const [flash, setFlash] = useState<string | null>(null);
  const gridApi = useRef<GridApi<LedgerRow> | null>(null);

  const load = useCallback(() => {
    api<{ rows: LedgerRow[] }>("/api/ledger?limit=500")
      .then((r) => {
        setRows(r.rows);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useLive((e) => {
    load();
    if (e.type === "request.updated" && e.request?.status === "paid") setFlash(`New row · ${e.request.display_id} paid`);
  });
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  const agents = useMemo(() => [...new Map((rows ?? []).map((r) => [r.agent_id, r.agent_name])).entries()], [rows]);
  const filtered = useMemo(() => {
    const f = STATUS_FILTERS.find((s) => s.id === status) ?? STATUS_FILTERS[0]!;
    return (rows ?? []).filter((r) => (agent === "all" || r.agent_id === agent) && f.match(r));
  }, [rows, agent, status]);

  const kpi = useMemo(() => {
    const all = rows ?? [];
    const paid = all.filter((r) => r.status === "paid");
    const denied = all.filter((r) => r.status === "denied");
    const sum = (xs: LedgerRow[]) => xs.reduce((s, r) => s + Number(r.amount), 0);
    const by = (d: string) => all.filter((r) => decisionLabel(r) === d).length;
    return {
      paid: sum(paid),
      matched: paid.filter((r) => r.payment?.reconciled === "matched").length,
      paidCount: paid.length,
      blocked: sum(denied),
      blockedCount: denied.length,
      total: all.length,
      auto: by("AUTO"),
      human: by("HUMAN"),
      denied: by("DENIED"),
    };
  }, [rows]);

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
          <div className="ledger-top">
            <div className="kpis">
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
                <span className="caption">{kpi.blockedCount} request(s) · nothing charged</span>
              </div>
              <div className="panel panel-tight stack-s">
                <span className="caption">Requests</span>
                <span className="metric">{kpi.total}</span>
                <span className="caption">
                  Auto {kpi.auto} · Human {kpi.human} · Denied {kpi.denied}
                </span>
              </div>
            </div>
            <section className="panel panel-tight stack-s" aria-labelledby="chart-h">
              <h2 id="chart-h" className="section-title">
                Paid by agent
              </h2>
              {rows ? <SpendChart rows={rows} /> : <div className="skeleton" style={{ minHeight: 220 }} />}
            </section>
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
            {rows === null ? (
              <div className="skeleton" style={{ minHeight: 420 }} aria-label="Loading transactions" />
            ) : rows.length === 0 ? (
              <div className="empty">
                <h2>No activity yet</h2>
                <p className="muted">Connect an agent (Agents) and its purchase requests appear here in real time.</p>
              </div>
            ) : (
              <LedgerGrid key={group ? "g" : "f"} rows={filtered} group={group} quickFilter={q} focusId={params.get("r")} onApi={(a) => (gridApi.current = a)} />
            )}
            <p className="caption">
              {filtered.length} of {rows?.length ?? 0} rows · expand a row for the auditor reason, mandate version, capture id and reconciliation.
            </p>
          </section>
        </div>
      )}
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
