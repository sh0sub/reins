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
  type IStatusPanelParams,
  type ICellRendererParams,
  type ValueFormatterParams,
} from "ag-grid-community";
import { LicenseManager, MasterDetailModule, RowGroupingModule, SetFilterModule, StatusBarModule } from "ag-grid-enterprise";
import type { LedgerRow } from "@reins/core";
import { Icon } from "@/components/Icon";
import { LedgerSkeleton } from "./LedgerSkeleton";
import { bucketTotal, decisionClass, decisionLabel, fullTime, hardRules, isSimId, recordedChip, shortPayId, shortTime, showKo, simId, statusChip, usdAmount } from "@/lib/format";

// Community for filter/sort/CSV/row selection; Enterprise for row grouping (agent), master/detail (row expansion), set filters and the status bar.
// No license key: AG Grid shows its trial watermark/console notice (#30 decision, see worklog).
ModuleRegistry.registerModules([AllCommunityModule, RowGroupingModule, MasterDetailModule, SetFilterModule, StatusBarModule]);
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
  return <Chip value={d} className={decisionClass(d)} />;
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
      title={isSimId(id) ? "Simulated id (offline demo data), click to copy" : "Copy PayPal capture id"}
      aria-label={`Copy PayPal id ${id}`}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(id).catch(() => undefined);
      }}
    >
      {shortPayId(id)}
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
/** 390 px ledger: one card per request (item, id · merchant · time, status chip); the chevron expands the same row detail. */
function CardCell(p: CustomCellRendererProps<LedgerRow>) {
  const [open, setOpen] = useState(() => p.node.expanded);
  useEffect(() => {
    const sync = () => setOpen(p.node.expanded);
    p.node.addEventListener("expandedChanged", sync);
    return () => p.node.removeEventListener("expandedChanged", sync);
  }, [p.node]);
  const row = p.data;
  if (!row) return null;
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

/** "recorded run" chip (tooltip: real recorded time and the shift) on rows replayed from the recorded sandbox run. */
function RecordedChip({ row }: { row: LedgerRow }) {
  const c = recordedChip(row.recorded);
  return c ? (
    <span className="status status-info" style={{ marginLeft: 8 }} title={c.title}>
      {c.label}
    </span>
  ) : null;
}

/** Row expansion (S4/S6 lite): rules, auditor reason EN/KO, mandate version, capture id, reconciliation. */
const showId = (id: string | null) => (id ? simId(id) : "—");
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
        {showKo() && (
          <>
            <dt>Audit · KO</dt>
            <dd lang="ko">{llm?.reasonKo ?? "—"}</dd>
          </>
        )}
        <dt>Decided by</dt>
        <dd>{human ? `${human.actor ?? "you"} (${human.decision === "APPROVE" ? "approved" : "denied"})` : llm ? `${llm.actor === "mock" ? "demo auditor (offline stand-in)" : "Claude"} · risk ${llm.risk ?? "?"}/10` : "hard rules"}</dd>
      </dl>
      <dl>
        <dt>Mandate</dt>
        <dd>v{row.mandate_version ?? "—"}</dd>
        <dt>PayPal</dt>
        <dd className="mono">
          {row.payment ? (row.payment.strategy === "treasury" ? `treasury payout · batch ${showId(row.payment.payout_batch_id)} · transaction ${showId(row.payment.capture_id)}` : `${row.payment.strategy} · order ${showId(row.payment.order_id)} · capture ${showId(row.payment.capture_id ?? row.payment.payout_batch_id)}`) : "not charged"}
          {row.payment && isSimId(row.payment.capture_id ?? row.payment.order_id) && <span className="status status-info" style={{ marginLeft: 8 }}>simulated</span>}
          {row.payment && <RecordedChip row={row} />}
        </dd>
        <dt>Txn Search</dt>
        <dd>
          {row.payment ? `${row.payment.reconciled}${row.payment.reconcile_note ? ` · ${row.payment.reconcile_note}` : ""}${row.payment.reconciled_at ? ` · ${fullTime(row.payment.reconciled_at)}` : ""}` : "n/a"}
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
        {typeof paid === "number" ? ` · ${usdAmount(paid)} paid` : ""}
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

/** Columns of the accounting CSV, in order. Some are hidden in the grid (Agent when grouped, most columns on a phone) and are still exported. */
const CSV_COLUMNS = ["created_at", "id", "agent_name", "items", "merchant", "amount", "decision", "status", "paypal", "recon", "risk"];

/**
 * "Download CSV for accounting": the grid's own export. Ticked rows only when any are ticked, otherwise every row the filters leave;
 * no group or total rows; ISO timestamps and plain numbers so a spreadsheet can sum the Amount column.
 */
export function exportAccountingCsv(api: GridApi<LedgerRow>): void {
  api.exportDataAsCsv({
    fileName: `reins-ledger-${new Date().toISOString().slice(0, 10)}.csv`,
    columnKeys: CSV_COLUMNS,
    onlySelected: api.getSelectedNodes().length > 0,
    skipRowGroups: true,
    skipPinnedBottom: true,
    processCellCallback: (p) => {
      if (p.column.getColId() === "created_at") return p.node?.data?.created_at ?? "";
      if (p.column.getColId() === "amount") return p.node?.data?.amount ?? "";
      return p.value == null ? "" : String(p.value);
    },
  });
}

/** Status bar panel: dollars of what the grid is showing, and of the ticked rows. Recomputed on filter, sort, data and selection changes. */
function LedgerStatus({ api }: IStatusPanelParams<LedgerRow>) {
  const [t, setT] = useState({ paid: 0, denied: 0, selected: 0, selectedCount: 0 });
  useEffect(() => {
    const calc = () => {
      const shown: LedgerRow[] = [];
      api.forEachNodeAfterFilter((n) => {
        if (n.data && !n.group) shown.push(n.data);
      });
      const picked = api.getSelectedNodes().flatMap((n) => (n.data ? [n.data] : []));
      setT({
        paid: shown.filter((r) => r.status === "paid").reduce((s, r) => s + Number(r.amount), 0),
        denied: bucketTotal(shown, "blocked"),
        selected: picked.reduce((s, r) => s + Number(r.amount), 0),
        selectedCount: picked.length,
      });
    };
    calc();
    const events = ["modelUpdated", "filterChanged", "selectionChanged", "rowDataUpdated"] as const;
    events.forEach((e) => api.addEventListener(e, calc));
    return () => events.forEach((e) => api.removeEventListener(e, calc));
  }, [api]);
  return (
    <span className="ledger-status num" role="status" aria-live="polite">
      <span>
        Paid <b>{usdAmount(t.paid)}</b>
      </span>
      <span>
        Denied <b className="bad-text">{usdAmount(t.denied)}</b>
      </span>
      <span>
        Selected <b>{t.selectedCount ? `${usdAmount(t.selected)} (${t.selectedCount})` : "none"}</b>
      </span>
    </span>
  );
}

/** Elements inside a row that must not open the drawer when clicked. */
const ROW_CLICK_IGNORE = "button, a, input, label, .ag-group-contracted, .ag-group-expanded, .ag-selection-checkbox, .ag-checkbox, .ag-row-drag";

const money = (p: ValueFormatterParams) => (typeof p.value === "number" ? usdAmount(p.value) : "");

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
  // null until mounted: the first client render matches the server/loading skeleton, then the real layout mounts once (no remount flash)
  const [narrowState, setNarrow] = useState<boolean | null>(null);
  const narrow = narrowState === true;
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
  }, [narrowState !== null]);
  const cols = useMemo<ColDef<LedgerRow>[]>(() => {
    const time: ColDef<LedgerRow> = {
      headerName: "Time",
      field: "created_at",
      sort: "desc",
      width: 150,
      minWidth: 150,
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
        // not shown on a phone, still part of the CSV export
        ...(["id", "items", "merchant", "decision", "status"] as const).map<ColDef<LedgerRow>>((k) => ({
          colId: k,
          headerName: k === "decision" ? "Rule outcome" : k[0]!.toUpperCase() + k.slice(1),
          hide: true,
          suppressColumnsToolPanel: true,
          valueGetter: (p) => (p.data ? (k === "id" ? p.data.display_id : k === "decision" ? decisionLabel(p.data) : p.data[k]) : null),
        })),
        { colId: "paypal", headerName: "PayPal ID", hide: true, valueGetter: (p) => p.data?.payment?.capture_id ?? p.data?.payment?.payout_batch_id ?? null },
        { colId: "recon", headerName: "Recon", hide: true, valueGetter: (p) => (p.data?.payment?.status === "completed" ? p.data.payment.reconciled : "n/a") },
        { colId: "risk", headerName: "Risk", hide: true, field: "risk" },
      ];
    }
    return [
      time,
      { headerName: "ID", colId: "id", valueGetter: (p) => p.data?.display_id ?? null, cellRenderer: IdCell, width: 74, sortable: false, filter: false },
      agent,
      { headerName: "Item", field: "items", flex: 1, minWidth: 140, tooltipField: "items" },
      { headerName: "Merchant", field: "merchant", width: 132, minWidth: 120, filter: "agSetColumnFilter" },
      amount,
      // one status column in the grid: the Status chip. The rule engine's own outcome stays available (column menu, filters) and in the CSV as "Rule outcome"
      { headerName: "Rule outcome", colId: "decision", hide: true, valueGetter: (p) => (p.data ? decisionLabel(p.data) : null), cellRenderer: DecisionCell, width: 110, filter: "agSetColumnFilter" },
      { headerName: "Status", field: "status", cellRenderer: StatusCell, width: 132, minWidth: 128, filter: "agSetColumnFilter", enableCellChangeFlash: true },
      { headerName: "PayPal ID", colId: "paypal", valueGetter: (p) => p.data?.payment?.capture_id ?? p.data?.payment?.payout_batch_id ?? null, cellRenderer: roomy ? PayPalIdCell : PayPalReconCell, width: roomy ? 92 : 116, suppressHeaderFilterButton: true },
      { headerName: "Recon", colId: "recon", hide: !roomy, valueGetter: (p) => (p.data?.payment?.status === "completed" ? p.data.payment.reconciled : "n/a"), cellRenderer: ReconCell, width: 64, filter: "agSetColumnFilter", suppressHeaderFilterButton: true },
      { headerName: "Risk", field: "risk", width: 64, minWidth: 64, type: "rightAligned", filter: "agNumberColumnFilter", suppressHeaderFilterButton: true },
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

  if (narrowState === null) return <LedgerSkeleton />;
  return (
    <div ref={boxRef} className="ledger-box">
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
        // desktop: tick rows to sum them in the status bar and to export only those; a phone gets cards without checkboxes
        rowSelection={narrow ? undefined : { mode: "multiRow", checkboxes: true, headerCheckbox: true, enableClickSelection: false, groupSelects: "descendants", isRowSelectable: (n) => Boolean(n.data) && !n.group }}
        selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: "left", resizable: false, suppressHeaderMenuButton: true }}
        statusBar={{
          statusPanels: [
            { statusPanel: "agTotalAndFilteredRowCountComponent", align: "left" },
            { statusPanel: "agSelectedRowCountComponent", align: "left" },
            { statusPanel: LedgerStatus, align: "right" },
          ],
        }}
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
        // a click anywhere on a request row opens the drawer; the chevron, checkbox, links and buttons keep their own job
        onRowClicked={(e) => {
          const target = e.event?.target as HTMLElement | null | undefined;
          if (!onOpen || !e.data || e.node.group || e.node.detail || e.node.footer || e.node.rowPinned) return;
          if (target?.closest(ROW_CLICK_IGNORE)) return;
          onOpen(e.data.request_id);
        }}
        getRowClass={(p) => (p.data && !p.node.group && !p.node.footer && !p.node.rowPinned ? "ledger-row-click" : undefined)}
      />
    </div>
  );
}
