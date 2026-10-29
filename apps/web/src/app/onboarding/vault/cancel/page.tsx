import Link from "next/link";

export default function VaultCancel() {
  return (
    <div className="panel stack" style={{ maxWidth: 560 }}>
      <h1>PayPal was not saved</h1>
      <p className="muted">You closed the PayPal window. Nothing was charged. You can try again or use Supervised checkout.</p>
      <div>
        <Link className="btn" href="/setup">
          Back to setup
        </Link>
      </div>
    </div>
  );
}
