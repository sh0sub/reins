"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Receipt } from "@reins/core";
import { api } from "@/lib/api";
import { fullTime, isSimId, recordedChip, simId } from "@/lib/format";

const MODE: Record<Receipt["payment"]["strategy"], string> = {
  vaulted: "Automatic (saved PayPal)",
  supervised: "PayPal checkout",
  treasury: "Treasury payout",
};

/** S4 receipt page: the link an agent hands back after a paid request (receipt.receipt_url). */
export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Receipt>(`/api/receipts/${encodeURIComponent(id)}`)
      .then(setReceipt)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) {
    return (
      <div className="panel stack" style={{ maxWidth: 560 }}>
        <h1>Receipt</h1>
        <p className="alert alert-bad" role="alert">
          {error}
        </p>
        <div>
          <Link className="btn" href="/ledger">
            Open the ledger
          </Link>
        </div>
      </div>
    );
  }
  if (!receipt) return <div className="skeleton" style={{ maxWidth: 560, minHeight: 320 }} aria-busy="true" aria-label="Loading receipt" />;

  const paypalId = receipt.payment.capture_id ?? receipt.payment.payout_batch_id ?? receipt.payment.order_id ?? "—";
  const recorded = recordedChip(receipt.recorded);
  return (
    <article className="panel stack-l" style={{ maxWidth: 560 }} aria-labelledby="receipt-title">
      <header className="stack-s">
        <span className="caption mono">{receipt.display_id} · Reins receipt</span>
        <h1 id="receipt-title">
          Paid ${receipt.amount} <span className="caption">{receipt.currency}</span>
        </h1>
        <p className="row">
          <span className="status status-ok">Paid</span>
          <span className="caption">{fullTime(receipt.paid_at)}</span>
        </p>
      </header>
      <dl className="receipt">
        <dt>Merchant</dt>
        <dd>{receipt.merchant}</dd>
        <dt>Item</dt>
        <dd>{receipt.items}</dd>
        <dt>Agent</dt>
        <dd>{receipt.agent_name}</dd>
        <dt>Approved by</dt>
        <dd>{receipt.approved_by === "auto" ? "Rules + auditor (automatic)" : `You, on ${receipt.approved_by === "telegram" ? "Telegram" : receipt.approved_by === "web" ? "the web inbox" : receipt.approved_by}`}</dd>
        <dt>Mandate</dt>
        <dd>v{receipt.mandate_version ?? "—"}</dd>
        <dt>Payment</dt>
        <dd>{MODE[receipt.payment.strategy]}</dd>
        <dt>PayPal ID</dt>
        <dd className="mono">
          {simId(paypalId)}
          {isSimId(paypalId) && <span className="status status-info" style={{ marginLeft: 8 }}>simulated</span>}
          {recorded && (
            <span className="status status-info" style={{ marginLeft: 8 }} title={recorded.title}>
              {recorded.label}
            </span>
          )}
        </dd>
        <dt>Reconciled</dt>
        <dd>{receipt.payment.reconciled === "matched" ? "Matched in PayPal Transaction Search" : receipt.payment.reconciled === "mismatch" ? "Mismatch, check the ledger" : "Not checked yet"}</dd>
        {recorded && (
          <>
            <dt>Recorded</dt>
            <dd title={recorded.title}>{fullTime(receipt.recorded!.recorded_at)} (real time; times on this demo are shifted)</dd>
          </>
        )}
        <dt>Requested</dt>
        <dd>{fullTime(receipt.requested_at)}</dd>
      </dl>
      <div className="row">
        <Link className="btn" href={`/ledger?r=${receipt.request_id}`}>
          View in ledger
        </Link>
        <button className="btn-link" onClick={() => window.print()}>
          Print
        </button>
      </div>
    </article>
  );
}
