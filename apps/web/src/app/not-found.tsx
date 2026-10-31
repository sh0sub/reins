import Link from "next/link";

/** Branded 404: rendered inside the app shell (root layout), so the sidebar and top bar stay readable. */
export default function NotFound() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Page not found</h1>
          <p className="muted">This link does not match anything in Reins.</p>
        </div>
      </div>
      <div className="empty" role="status">
        <h2>Nothing here</h2>
        <p className="muted">The page may have moved, or the request id is mistyped. Try one of these instead.</p>
        <div className="row">
          <Link className="btn btn-primary" href="/overview">
            Back to overview
          </Link>
          <Link className="btn" href="/ledger">
            Open ledger
          </Link>
        </div>
      </div>
    </>
  );
}
