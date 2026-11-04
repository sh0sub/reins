"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type GetRowIdParams,
  type GridApi,
  type IAggFuncParams,
  type ICellRendererParams,
  type ValueFormatterParams,
} from "ag-grid-community";
import { LicenseManager, MasterDetailModule, RowGroupingModule, SetFilterModule } from "ag-grid-enterprise";
import type { LedgerRow } from "@reins/core";
import { Icon } from "@/components/Icon";
import { decisionLabel, hardRules, shortTime, statusChip } from "@/lib/format";

// Community for filter/sort/CSV; Enterprise only for row grouping (agent) and master/detail (row expansion).
// No license key: AG Grid shows its trial watermark/console notice (#30 decision, see worklog).
ModuleRegistry.registerModules([AllCommunityModule, RowGroupingModule, MasterDetailModule, SetFilterModule]);
// AG Grid license keys are meant to ship in the client bundle; without one, Enterprise shows a trial watermark off localhost
if (process.env.NEXT_PUBLIC_AG_GRID_LICENSE_KEY) LicenseManager.setLicenseKey(process.env.NEXT_PUBLIC_AG_GRID_LICENSE_KEY);

const theme = themeQuartz.withParams({
  accentColor: "var(--reins-navy)",
  foregroundColor: "var(--reins-ink)",
  borderColor: "var(--reins-line)",
  headerBackgroundColor: "var(--reins-canvas)",
  headerTextColor: "var(--reins-ink-2)",
  fontFamily: "inherit",
  fontSize: 13,
  rowHeight: 40,
  headerHeight: 40,
  wrapperBorderRadius: 12,
  cellHorizontalPadding: 8,
});

function Chip({ value, className }: { value: string; className: string }) {
  return <span className={className}>{value}</span>;
}

function DecisionCell(p: CustomCellRendererProps<LedgerRow>) {
  if (!p.data) return null;
  const d = decisionLabel(p.data);
  return <Chip value={d} className={d === "DENIED" ? "status status-bad" : d === "HUMAN" ? "status status-warn" : d === "AUTO" ? "status status-ok" : "status"} />;
}
function StatusCell(p: CustomCellRendererProps<LedgerRow>) {
  if (!p.data) return null;
  const c = statusChip(p.data);
  return <Chip value={c.label} className={c.className} />;
}
function PayPalIdCell(p: CustomCellRendererProps<LedgerRow>) {
  if (!p.data) return null;
  const id = p.data.payment?.capture_id ?? p.data.payment?.payout_batch_id ?? null;
  if (!id) return <span className="caption">—</span>;
  return (
    <button
      type="button"
      className="btn-link mono"
      style={{ minHeight: 32, padding: 0 }}
      title="Copy PayPal capture id"
      aria-label={`Copy PayPal id ${id}`}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(id).catch(() => undefined);
      }}
    >
      {id.slice(0, 5)}…{id.slice(-1)}
    </button>
  );
}
/** PayPal ID plus the reconciliation icon, for grids too narrow for a separate Recon column. */
function PayPalReconCell(p: CustomCellRendererProps<LedgerRow>) {
  return (
    <span className="ledger-id-recon">
      <PayPalIdCell {...p} />
      <ReconCell {...p} />
    </span>
  );
}
/** R-0143: opens the S6 drawer (grid rows are 40px, so the hit area is the full row height; the expansion has a 48px button too). */
function IdCell(p: CustomCellRendererProps<LedgerRow>) {
  if (!p.data) return null;
  const open = (p.context as GridContext | undefined)?.openDrawer;
  const id = p.data.request_id;
  return (
    <button
      type="button"
      className="btn-link cell-link"
      aria-label={`Open details for ${p.data.display_id}`}
      onClick={(e) => {
        e.stopPropagation();
        open?.(id);
      }}
    >
      {p.data.display_id}
    </button>
  );
}
/** 390 px ledger: one card per request (item, id · merchant · time, decision + status chips); the chevron expands the same row detail. */
function CardCell(p: CustomCellRendererProps<LedgerRow>) {
  const [open, setOpen] = useState(() => p.node.expanded);
  useEffect(() => {
    const sync = () => setOpen(p.node.expanded);
    p.node.addEventListener("expandedChanged", sync);
    return () => p.node.removeEventListener("expandedChanged", sync);
  }, [p.node]);
  const row = p.data;
  if (!row) return null;
  const d = decisionLabel(row);
  const st = statusChip(row);
  const openDrawer = (p.context as GridContext | undefined)?.openDrawer;
  const showAgent = Boolean((p as { showAgent?: boolean }).showAgent);
  return (
    <div className="ledger-card">
      <button type="button" className="ledger-card-toggle" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} details for ${row.display_id}`} onClick={() => p.node.setExpanded(!open)}>
        <Icon name="arrow" className={open ? "ico-s ledger-card-chev is-open" : "ico-s ledger-card-chev"} />
      </button>
      <div className="ledger-card-body">
        <div className="ledger-card-title">{row.items}</div>
        <div className="ledger-card-meta">
          <button type="button" className="btn-link cell-link" aria-label={`Open details for ${row.display_id}`} onClick={() => openDrawer?.(row.request_id)}>
            {row.display_id}
          </button>{" "}
          <span>
            · {showAgent ? `${row.agent_name} · ` : ""}
            {row.merchant} · {shortTime(row.created_at).replace(/ /g, "\u00a0")}
          </span>
        </div>
        <div className="ledger-card-chips">
          {d !== "PENDING" && d.toLowerCase() !== st.label.toLowerCase() && (
            <Chip value={d} className={d === "DENIED" ? "status status-bad" : d === "HUMAN" ? "status status-warn" : d === "AUTO" ? "status status-ok" : "status"} />
          )}
          <Chip value={st.label} className={st.className} />
        </div>
      </div>
    </div>
  );
}
interface GridContext {
  openDrawer?: (id: string) => void;
}
function ReconCell(p: CustomCellRendererProps<LedgerRow>) {
  if (!p.data) return null;
  const r = p.data?.payment?.status === "completed" ? p.data.payment.reconciled : null;
  if (!r) return <span className="caption" title="Not reconciled (no completed PayPal payment)">n/a</span>;
  // icon + hidden word keeps the column narrow so Status, PayPal ID and Risk all fit at 1440 px
  return (
    <span className={r === "matched" ? "status status-ok" : r === "mismatch" ? "status status-bad" : "status"} title={`Transaction Search: ${r}`}>
      {r === "matched" ? <Icon name="check" className="ico-s" /> : r === "mismatch" ? <Icon name="x" className="ico-s" /> : <Icon name="clock" className="ico-s" />}
      <span className="sr-only">{r}</span>
    </span>
  );
}

/** Row expansion (S4/S6 lite): rules, auditor reason EN/KO, mandate version, capture id, reconciliation. */
function Detail(p: ICellRendererParams<LedgerRow>) {
  const row = p.data;
  if (!row) return null;
  const rules = hardRules(row);
  const failed = rules.filter((r) => !r.ok);
  const llm = row.decisions.find((d) => d.stage === "llm");
  const human = row.decisions.find((d) => d.stage === "human");
  const tighten = row.status === "denied" && failed.length > 0;
  const capRule = failed.find((r) => r.rule === "per_tx_cap");
  const tightenHref = `/agents?agent=${row.agent_id}&block=${encodeURIComponent(row.merchant)}${capRule ? "&cap=60" : ""}`;
  const openDrawer = (p.context as GridContext | undefined)?.openDrawer;
  return (
    <div className="ledger-detail" role="region" aria-label={`Details for ${row.display_id}`}>
      <dl>
        <dt>Rules</dt>
        <dd>{rules.length ? (failed.length ? failed.map((r) => r.detail).join("; ") : `All ${rules.length} passed`) : "—"}</dd>
        <dt>Audit · EN</dt>
        <dd>{llm?.reasonEn ?? "—"}</dd>
        <dt>Audit · KO</dt>
        <dd lang="ko">{llm?.reasonKo ?? "—"}</dd>
        <dt>Decided by</dt>
        <dd>{human ? `${human.actor} (${human.decision})` : llm ? `${llm.actor === "mock" ? "mock auditor" : "Claude"} · risk ${llm.risk ?? "?"}/10` : "hard rules"}</dd>
      </dl>
      <dl>
        <dt>Mandate</dt>
        <dd>v{row.mandate_version ?? "—"}</dd>
        <dt>PayPal</dt>
        <dd className="mono">
          {row.payment ? `${row.payment.strategy} · order ${row.payment.order_id ?? "—"} · capture ${row.payment.capture_id ?? row.payment.payout_batch_id ?? "—"}` : "not charged"}
        </dd>
        <dt>Txn Search</dt>
        <dd>
          {row.payment ? `${row.payment.reconciled}${row.payment.reconcile_note ? ` · ${row.payment.reconcile_note}` : ""}${row.payment.reconciled_at ? ` · ${new Date(row.payment.reconciled_at).toLocaleString()}` : ""}` : "n/a"}
        </dd>
        <dt>Agent said</dt>
        <dd>“{row.agent_reason}”</dd>
        {row.anomalies?.length > 0 && (
          <>
            <dt>Patterns</dt>
            <dd>{row.anomalies.map((a) => a.detail_en).join("; ")}</dd>
          </>
        )}
      </dl>
      {openDrawer && (
        <div>
          <button type="button" className="btn" onClick={() => openDrawer(row.request_id)}>
            Open details
          </button>
        </div>
      )}
      {row.receipt?.receipt_url && (
        <div>
          <a className="btn" href={`/receipts/${row.request_id}`}>
            View receipt
          </a>
        </div>
      )}
      {tighten && (
        <div>
          <a className="btn" href={tightenHref}>
            Tighten mandate
          </a>
        </div>
      )}
    </div>
  );
}

/** Phone group header (full-width row): agent name, request count and what was paid. */
function GroupRowLabel(p: { value?: string; node: { allChildrenCount: number | null; aggData?: Record<string, unknown> } }) {
  const paid = p.node.aggData?.amount;
  return (
    <span className="ledger-group-row">
      <strong>{p.value}</strong>
      <span>
        {p.node.allChildrenCount} {p.node.allChildrenCount === 1 ? "request" : "requests"}
        {typeof paid === "number" ? ` · $${paid.toFixed(2)} paid` : ""}
      </span>
    </span>
  );
}

function TotalCell() {
  return <strong>Total</strong>;
}

function paidSum(p: IAggFuncParams<LedgerRow>): number {
  let total = 0;
  p.rowNode.allLeafChildren?.forEach((n) => {
    if (n.data?.status === "paid") total += Number(n.data.amount);
  });
  return Math.round(total * 100) / 100;
}

const money = (p: ValueFormatterParams) => (typeof p.value === "number" ? `$${p.value.toFixed(2)}` : "");

export function LedgerGrid({
  rows,
  group,
  quickFilter,
  focusId,
  onApi,
  onOpen,
}: {
  rows: LedgerRow[];
  group: boolean;
  quickFilter: string;
  focusId?: string | null;
  onApi?: (api: GridApi<LedgerRow>) => void;
  /** S6: open the request-detail drawer. */
  onOpen?: (id: string) => void;
}) {
  const context = useMemo<GridContext>(() => ({ openDrawer: onOpen }), [onOpen]);
  const apiRef = useRef<GridApi<LedgerRow> | null>(null);
  // phones: keep Agent/time, Item, Amount and Status visible; the rest is one tap away in the row detail and drawer
  // (this component only renders client-side, see the dynamic import with ssr: false)
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 719px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 719px)");
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  // desktop: Recon (an icon column) drops out when the grid itself is narrower than 1240 px (its icon then sits inside the PayPal ID cell), so Time, Item and Merchant never truncate hard
  const boxRef = useRef<HTMLDivElement>(null);
  const [roomy, setRoomy] = useState(true);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setRoomy((e?.contentRect.width ?? 1100) >= 1240));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols = useMemo<ColDef<LedgerRow>[]>(() => {
    const time: ColDef<LedgerRow> = {
      headerName: "Time",
      field: "created_at",
      sort: "desc",
      width: 128,
      // phones: the card shows the time; this column only keeps the newest-first sort
      hide: narrow,
      // carries the row-detail chevron and the pinned "Total" label (group rows are full width, so no group column does)
      cellRendererSelector: (p) => (p.node.footer ? { component: TotalCell } : { component: "agGroupCellRenderer" }),
      valueFormatter: (p) => shortTime(p.value),
      filter: "agDateColumnFilter",
      filterValueGetter: (p) => (p.data ? new Date(p.data.created_at) : null),
    };
    const agent: ColDef<LedgerRow> = { headerName: "Agent", field: "agent_name", rowGroup: group, hide: group || narrow, enableRowGroup: true, filter: "agSetColumnFilter" };
    // Group/grand totals sum only paid rows (blocked and failed requests were never charged).
    const amount: ColDef<LedgerRow> = { headerName: "Amount", colId: "amount", valueGetter: (p) => (p.data ? Number(p.data.amount) : null), valueFormatter: money, aggFunc: paidSum, type: "rightAligned", width: narrow ? 84 : 96, minWidth: narrow ? 74 : 96, filter: "agNumberColumnFilter", suppressHeaderFilterButton: true };
    if (narrow) {
      return [
        time,
        agent,
        { headerName: "Request", colId: "card", flex: 1, minWidth: 190, autoHeight: true, sortable: false, filter: false, resizable: false, valueGetter: (p) => p.data?.items ?? null, cellRendererSelector: (p) => (p.node.footer ? { component: TotalCell } : { component: CardCell, params: { showAgent: !group } }), cellClass: "ledger-card-cell" },
        amount,
      ];
    }
    return [
      time,
      { headerName: "ID", colId: "id", valueGetter: (p) => p.data?.display_id ?? null, cellRenderer: IdCell, width: 74, sortable: false, filter: false },
      agent,
      { headerName: "Item", field: "items", flex: 2, minWidth: 110, tooltipField: "items" },
      { headerName: "Merchant", field: "merchant", width: 132, minWidth: 120, filter: "agSetColumnFilter" },
      amount,
      { headerName: "Decision", colId: "decision", valueGetter: (p) => (p.data ? decisionLabel(p.data) : null), cellRenderer: DecisionCell, width: 96, filter: "agSetColumnFilter" },
      { headerName: "Status", field: "status", cellRenderer: StatusCell, width: 132, minWidth: 128, filter: "agSetColumnFilter", enableCellChangeFlash: true },
      { headerName: "PayPal ID", colId: "paypal", valueGetter: (p) => p.data?.payment?.capture_id ?? p.data?.payment?.payout_batch_id ?? null, cellRenderer: roomy ? PayPalIdCell : PayPalReconCell, width: roomy ? 92 : 116, suppressHeaderFilterButton: true },
      { headerName: "Recon", colId: "recon", hide: !roomy, valueGetter: (p) => (p.data?.payment?.status === "completed" ? p.data.payment.reconciled : "n/a"), cellRenderer: ReconCell, width: 64, filter: "agSetColumnFilter", suppressHeaderFilterButton: true },
      { headerName: "Risk", field: "risk", width: 56, minWidth: 52, type: "rightAligned", filter: "agNumberColumnFilter", suppressHeaderFilterButton: true },
    ];
  }, [group, narrow, roomy]);

  useEffect(() => {
    apiRef.current?.setGridOption("quickFilterText", quickFilter);
  }, [quickFilter]);

  // the grid may become ready (or receive rows) after this effect runs, so the grid callbacks retry the focus too
  const focusRow = useCallback(() => {
    const api = apiRef.current;
    if (!focusId || !api) return;
    const node = api.getRowNode(focusId);
    if (node) {
      node.setExpanded(true);
      api.ensureNodeVisible(node, "middle");
    }
  }, [focusId]);

  useEffect(focusRow, [focusRow, rows]);

  return (
    <div ref={boxRef} style={{ height: narrow ? "calc(100dvh - 140px)" : "calc(100dvh - 190px)", minHeight: 420 }}>
      <AgGridReact<LedgerRow>
        key={narrow ? "cards" : "table"}
        theme={theme}
        rowData={rows}
        columnDefs={cols}
        context={context}
        getRowId={(p: GetRowIdParams<LedgerRow>) => p.data.request_id}
        defaultColDef={{ sortable: true, resizable: true, filter: true, minWidth: 60 }}
        autoSizeStrategy={{ type: "fitGridWidth" }}
        suppressAggFuncInHeader
        // full-width group rows (agent, request count, paid total): leaves keep the whole width instead of a mostly empty group column
        groupDisplayType="groupRows"
        groupRowRendererParams={{ innerRenderer: GroupRowLabel, suppressCount: true }}
        groupDefaultExpanded={1}
        // rows never slide under a stuck group row, so every row of the last group is readable without extra scrolling
        suppressGroupRowsSticky
        // reserve the scrollbar lane from the start, so columns fitted to the width still fit once rows overflow (Risk was cut)
        alwaysShowVerticalScroll
        groupTotalRow={undefined}
        grandTotalRow="pinnedBottom"
        masterDetail
        isRowMaster={() => true}
        detailCellRenderer={Detail}
        detailRowAutoHeight
        animateRows
        quickFilterText={quickFilter}
        pagination={rows.length > 50}
        paginationPageSize={50}
        overlayNoRowsTemplate="<span>No activity yet. Connect an agent and its purchases land here.</span>"
        onGridReady={(e) => {
          apiRef.current = e.api;
          onApi?.(e.api);
          focusRow();
        }}
        // first load always starts at the top (a kept scroll offset hid rows of the last group at 1440 px)
        onFirstDataRendered={(e) => {
          if (!focusId) e.api.ensureIndexVisible(0, "top");
        }}
        onRowDataUpdated={focusRow}
      />
    </div>
  );
}
