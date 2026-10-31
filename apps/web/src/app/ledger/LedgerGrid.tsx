"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
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
function ReconCell(p: CustomCellRendererProps<LedgerRow>) {
  const r = p.data?.payment?.status === "completed" ? p.data.payment.reconciled : null;
  if (!r) return <span className="caption">n/a</span>;
  return <Chip value={r} className={r === "matched" ? "status status-ok" : r === "mismatch" ? "status status-bad" : "status"} />;
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
}: {
  rows: LedgerRow[];
  group: boolean;
  quickFilter: string;
  focusId?: string | null;
  onApi?: (api: GridApi<LedgerRow>) => void;
}) {
  const apiRef = useRef<GridApi<LedgerRow> | null>(null);
  const cols = useMemo<ColDef<LedgerRow>[]>(
    () => [
      {
        headerName: "Time",
        field: "created_at",
        sort: "desc",
        width: 140,
        cellRenderer: group ? undefined : "agGroupCellRenderer",
        valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : ""),
        filter: "agDateColumnFilter",
        filterValueGetter: (p) => (p.data ? new Date(p.data.created_at) : null),
      },
      { headerName: "Agent", field: "agent_name", rowGroup: group, hide: group, enableRowGroup: true, filter: "agSetColumnFilter" },
      { headerName: "Item", field: "items", flex: 2, minWidth: 180, tooltipField: "items" },
      { headerName: "Merchant", field: "merchant", width: 150, filter: "agSetColumnFilter" },
      // Group/grand totals sum only paid rows (blocked and failed requests were never charged).
      { headerName: "Amount", colId: "amount", valueGetter: (p) => (p.data ? Number(p.data.amount) : null), valueFormatter: money, aggFunc: paidSum, type: "rightAligned", width: 110, filter: "agNumberColumnFilter" },
      { headerName: "Decision", colId: "decision", valueGetter: (p) => (p.data ? decisionLabel(p.data) : null), cellRenderer: DecisionCell, width: 120, filter: "agSetColumnFilter" },
      { headerName: "Status", field: "status", cellRenderer: StatusCell, width: 140, filter: "agSetColumnFilter", enableCellChangeFlash: true },
      { headerName: "PayPal ID", colId: "paypal", valueGetter: (p) => p.data?.payment?.capture_id ?? p.data?.payment?.payout_batch_id ?? null, cellRenderer: PayPalIdCell, width: 120 },
      { headerName: "Recon", colId: "recon", valueGetter: (p) => (p.data?.payment?.status === "completed" ? p.data.payment.reconciled : "n/a"), cellRenderer: ReconCell, width: 110, filter: "agSetColumnFilter" },
      { headerName: "Risk", field: "risk", width: 80, type: "rightAligned", filter: "agNumberColumnFilter" },
    ],
    [group],
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
        getRowId={(p: GetRowIdParams<LedgerRow>) => p.data.request_id}
        defaultColDef={{ sortable: true, resizable: true, filter: true, minWidth: 70 }}
        suppressAggFuncInHeader
        autoGroupColumnDef={{ headerName: "Agent / time", minWidth: 220, cellRendererParams: { suppressCount: false } }}
        groupDefaultExpanded={1}
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
        onRowDataUpdated={focusRow}
      />
    </div>
  );
}
