"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";

/** PayPal return_url for the $0.01 store_in_vault order (M8 onboarding): capture + save the vault id. */
function VaultReturn() {
  const token = useSearchParams().get("token");
  const [state, setState] = useState<{ ok: boolean | null; text: string }>({ ok: null, text: "Saving your PayPal for automatic payments…" });
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) {
      setState({ ok: false, text: "PayPal did not return an order token. Start again from Setup." });
      return;
    }
    api<{ payment_mode: string; has_vault: boolean }>("/api/paypal/vault/complete", { method: "POST", body: { order_id: token } })
      .then((r) => setState(r.has_vault ? { ok: true, text: "PayPal saved. Agents can now pay automatically inside their mandates." } : { ok: false, text: "PayPal did not save a payment token. Use Supervised or Treasury mode." }))
      .catch((e: Error) => setState({ ok: false, text: e.message }));
  }, [token]);
  return (
    <div className="panel stack" style={{ maxWidth: 560 }}>
      <h1>Automatic payments</h1>
      <p className={state.ok === null ? "alert" : state.ok ? "alert alert-ok" : "alert alert-bad"} role="status">
        {state.text}
      </p>
      <div>
        <Link className={state.ok ? "btn btn-primary" : "btn"} href="/setup">
          Back to setup
        </Link>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="skeleton" />}>
      <VaultReturn />
    </Suspense>
  );
}
