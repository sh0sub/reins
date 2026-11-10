"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";

type Outcome = "paid" | "pending" | "failed" | "canceled" | "not_approved" | "unchanged";
interface Result {
  outcome: Outcome;
  request: { request_id: string; display_id: string; status: string; amount: string; currency: string; merchant: string };
}

const STATUS_TEXT: Record<string, { ok: boolean | null; text: (r: Result["request"]) => string }> = {
  paid: { ok: true, text: (r) => `Paid $${r.amount} to ${r.merchant}. The receipt is ready.` },
  paying: { ok: null, text: () => "PayPal is still confirming this payment. The ledger updates on its own when it settles." },
  awaiting_buyer: { ok: null, text: () => "PayPal has not confirmed your approval yet. Finish the checkout on PayPal, then come back." },
  failed: { ok: false, text: (r) => `${r.display_id} was not paid. Nothing counts against the budget.` },
  expired: { ok: false, text: (r) => `${r.display_id} expired before checkout finished. Nothing counts against the budget.` },
  denied: { ok: false, text: (r) => `${r.display_id} was denied, so nothing was charged.` },
};

/** H5 PayPal return_url / cancel_url: asks the server to capture (or cancel) once, then shows the request's status. */
function Checkout({ kind }: { kind: "return" | "cancel" }) {
  const params = useSearchParams();
  const request = params.get("request");
  const token = params.get("token");
  const [state, setState] = useState<{ result: Result | null; error: string | null }>({ result: null, error: null });
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!request) {
      setState({ result: null, error: "This link is missing its request id. Open the request from the ledger instead." });
      return;
    }
    api<Result>(`/api/pay/${kind}`, { method: "POST", body: { request, token } })
      .then((result) => setState({ result, error: null }))
      .catch((e: Error) => setState({ result: null, error: e.message }));
  }, [kind, request, token]);

  const r = state.result?.request;
  const view = r ? (STATUS_TEXT[r.status] ?? { ok: null, text: () => `${r.display_id} is ${r.status.replace(/_/g, " ")}.` }) : null;
  const pendingText = kind === "cancel" ? "Canceling the checkout…" : "Confirming your payment with PayPal…";
  const text =
    state.error ??
    (r && view
      ? state.result?.outcome === "canceled"
        ? `You canceled the PayPal checkout for ${r.display_id}. Nothing was charged and the budget is free again.`
        : view.text(r)
      : pendingText);
  const ok = state.error ? false : (view?.ok ?? null);
  return (
    <div className="panel stack" style={{ maxWidth: 560 }}>
      <h1>{kind === "cancel" ? "Checkout canceled" : "PayPal checkout"}</h1>
      <p className={ok === null ? "alert" : ok ? "alert alert-ok" : "alert alert-bad"} role="status" aria-live="polite">
        {text}
      </p>
      <div className="row">
        {r?.status === "paid" ? (
          <Link className="btn btn-primary" href={`/receipts/${r.display_id}`}>
            View receipt
          </Link>
        ) : null}
        <Link className={r?.status === "paid" ? "btn" : "btn btn-primary"} href={r ? `/ledger?r=${r.request_id}` : "/ledger"}>
          Open ledger
        </Link>
      </div>
    </div>
  );
}

export function CheckoutResult({ kind }: { kind: "return" | "cancel" }) {
  return (
    <Suspense fallback={<div className="skeleton" />}>
      <Checkout kind={kind} />
    </Suspense>
  );
}
