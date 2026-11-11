import Link from "next/link";
import { PROOF_ITEMS, proofLogUrl } from "./proof";

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/** Read-only "Proof" page: the real PayPal sandbox ids from the spike runs, labelled as a recorded run. Static, no PayPal call. */
export default function ProofPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>PayPal sandbox proof</h1>
          <p className="tagline">
            Real sandbox ids from the spike runs that first proved each payment path. <span className="status status-info">recorded, not live</span>
          </p>
        </div>
      </div>
      <p className="muted proof-lead">
        On the hosted demo the seeded ledger is a recorded real sandbox run (PayPal Payouts plus Claude audits, every row marked
        &quot;recorded run&quot;, times shifted to now) and <Link href="/try">/try</Link> makes real sandbox payments. A local{" "}
        <code>pnpm judge</code> uses simulated PayPal (SIM ids) and says so. Below are the spike runs behind each PayPal API, copied
        from the spike logs in the repository. Nothing here talks to PayPal when you open it.
      </p>
      <ul className="proof-list">
        {PROOF_ITEMS.map((p) => (
          <li key={p.id} className="panel stack" id={p.id}>
            <div className="row between">
              <h2 className="h-card">{p.title}</h2>
              <span className={p.status.includes("401") ? "status status-ok" : p.status === "COMPLETED" || p.status === "SUCCESS" ? "status status-ok" : "status"}>{p.status}</span>
            </div>
            <p>{p.what}</p>
            <dl className="receipt">
              {p.ids.map((i) => (
                <div key={i.label} className="proof-id">
                  <dt>{i.label}</dt>
                  <dd className="mono">{i.value}</dd>
                </div>
              ))}
              {p.amount && (
                <div className="proof-id">
                  <dt>Amount</dt>
                  <dd className="num">${p.amount} USD</dd>
                </div>
              )}
              <div className="proof-id">
                <dt>Recorded</dt>
                <dd>{day(p.at)}</dd>
              </div>
            </dl>
            <p>
              <a className="btn" href={proofLogUrl(p.log)} target="_blank" rel="noreferrer">
                Spike log: {p.log.split("/").pop()}
              </a>
            </p>
          </li>
        ))}
      </ul>
      <p className="caption">Sandbox amounts are tiny on purpose ($0.01 and $1.23); the demo amounts ($12.98, $59) run through the same calls.</p>
    </>
  );
}
