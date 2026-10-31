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
import { decisionLabel, hardRules, statusChip } from "@/lib/format";

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
  const id = p.data?.payment?.capture_id ?? p.data?.payment?.payout_batch_id ?? null;
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
interface GridContext {
  openDrawer?: (id: string) => void;
}
function ReconCell(p: CustomCellRendererProps<LedgerRow>) {
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
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 719px)");
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  const cols = useMemo<ColDef<LedgerRow>[]>(
    () => [
      {
        headerName: "Time",
        field: "created_at",
        sort: "desc",
        width: 112,
        minWidth: narrow ? 70 : undefined,
        // on a phone the group column carries the agent name and the expander, so grouped rows drop this column
        hide: narrow && group,
        cellRenderer: group ? undefined : "agGroupCellRenderer",
        valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : ""),
        filter: "agDateColumnFilter",
        filterValueGetter: (p) => (p.data ? new Date(p.data.created_at) : null),
      },
      { headerName: "ID", colId: "id", valueGetter: (p) => p.data?.display_id ?? null, cellRenderer: IdCell, hide: narrow, width: 78, sortable: false, filter: false },
      { headerName: "Agent", field: "agent_name", rowGroup: group, hide: group, enableRowGroup: true, filter: "agSetColumnFilter" },
      { headerName: "Item", field: "items", flex: 2, minWidth: narrow ? 70 : 130, tooltipField: "items" },
      { headerName: "Merchant", field: "merchant", hide: narrow, width: 112, filter: "agSetColumnFilter" },
      // Group/grand totals sum only paid rows (blocked and failed requests were never charged).
      { headerName: "Amount", colId: "amount", valueGetter: (p) => (p.data ? Number(p.data.amount) : null), valueFormatter: money, aggFunc: paidSum, type: "rightAligned", width: 84, minWidth: narrow ? 66 : undefined, filter: "agNumberColumnFilter", suppressHeaderFilterButton: true },
      { headerName: "Decision", colId: "decision", hide: narrow, valueGetter: (p) => (p.data ? decisionLabel(p.data) : null), cellRenderer: DecisionCell, width: 98, filter: "agSetColumnFilter", suppressHeaderFilterButton: true },
      { headerName: "Status", field: "status", cellRenderer: StatusCell, width: 138, minWidth: narrow ? 84 : 130, filter: "agSetColumnFilter", enableCellChangeFlash: true },
      { headerName: "PayPal ID", colId: "paypal", hide: narrow, valueGetter: (p) => p.data?.payment?.capture_id ?? p.data?.payment?.payout_batch_id ?? null, cellRenderer: PayPalIdCell, width: 100, suppressHeaderFilterButton: true },
      { headerName: "Recon", colId: "recon", hide: narrow, valueGetter: (p) => (p.data?.payment?.status === "completed" ? p.data.payment.reconciled : "n/a"), cellRenderer: ReconCell, width: 64, filter: "agSetColumnFilter", suppressHeaderFilterButton: true },
      { headerName: "Risk", field: "risk", hide: narrow, width: 64, minWidth: 60, type: "rightAligned", filter: "agNumberColumnFilter", suppressHeaderFilterButton: true },
    ],
    [group, narrow],
  );

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
    <div style={{ height: "min(70vh, 640px)", minHeight: 420 }}>
      <AgGridReact<LedgerRow>
        theme={theme}
        rowData={rows}
        columnDefs={cols}
        context={context}
        getRowId={(p: GetRowIdParams<LedgerRow>) => p.data.request_id}
        defaultColDef={{ sortable: true, resizable: true, filter: true, minWidth: 60 }}
        autoSizeStrategy={{ type: "fitGridWidth" }}
        suppressAggFuncInHeader
        autoGroupColumnDef={{ headerName: "Agent / time", width: narrow ? 128 : 250, minWidth: narrow ? 110 : 200, cellRendererParams: { suppressCount: false } }}
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
