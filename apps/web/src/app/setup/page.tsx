"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Icon } from "@/components/Icon";

interface WorkspaceView {
  paypal_env: string;
  merchant_email: string | null;
  payment_mode: "vaulted" | "supervised" | "treasury";
  has_vault: boolean;
  telegram_linked: boolean;
  telegram_bot: string;
  connected_at: string | null;
}

type StepState = "done" | "current" | "todo";

function StepHead({ n, title, state, note }: { n: number; title: string; state: StepState; note?: string }) {
  return (
    <div className="row between">
      <h2 className="row" style={{ gap: 12 }}>
        <span className={state === "done" ? "status status-ok" : state === "current" ? "status status-info" : "status"} aria-hidden>
          {state === "done" ? <Icon name="check" className="ico-s" /> : n}
        </span>
        {title}
      </h2>
      <span className={state === "done" ? "status status-ok" : "status"}>{state === "done" ? note ?? "Done" : state === "current" ? "In progress" : "Waiting"}</span>
    </div>
  );
}

/** Screen S1: connect PayPal sandbox -> save a payment method (vault $0.01 or Treasury) -> link Telegram. */
export default function SetupPage() {
  const [ws, setWs] = useState<WorkspaceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creds, setCreds] = useState({ client_id: "", client_secret: "" });
  const [showSecret, setShowSecret] = useState(false);
  const [msg, setMsg] = useState<{ step: number; text: string; bad?: boolean } | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => api<WorkspaceView>("/api/workspace").then((w) => (setWs(w), w)).catch((e: Error) => (setError(e.message), null)), []);
  useEffect(() => {
    void load();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [load]);

  /** Poll the workspace every 3 s for up to 2 min (vault approval in another window, Telegram /start). */
  function watch(until: (w: WorkspaceView) => boolean) {
    if (poll.current) clearInterval(poll.current);
    const stopAt = Date.now() + 120_000;
    poll.current = setInterval(async () => {
      const w = await load();
      if ((w && until(w)) || Date.now() > stopAt) {
        clearInterval(poll.current!);
        poll.current = null;
      }
    }, 3000);
  }

  async function connect(e: FormEvent | null, demo: boolean) {
    e?.preventDefault();
    setBusy("connect");
    setMsg(null);
    try {
      await api("/api/paypal/connect", { method: "POST", body: demo ? { demo: true } : creds });
      setCreds({ client_id: "", client_secret: "" });
      await load();
    } catch (err) {
      setMsg({ step: 1, text: (err as Error).message, bad: true });
    } finally {
      setBusy(null);
    }
  }

  async function startVault() {
    setBusy("vault");
    setMsg(null);
    try {
      const r = await api<{ orderId: string; approveUrl: string }>("/api/paypal/vault/start", { method: "POST" });
      window.open(r.approveUrl, "_blank", "noopener");
      setMsg({ step: 2, text: "PayPal opened in a new window. Approve the $0.01 verification there; this page updates when it returns." });
      watch((w) => w.has_vault);
    } catch (err) {
      setMsg({ step: 2, text: (err as Error).message, bad: true });
    } finally {
      setBusy(null);
    }
  }

  async function setMode(mode: WorkspaceView["payment_mode"]) {
    setBusy("mode");
    try {
      await api("/api/workspace/mode", { method: "POST", body: { mode } });
      await load();
    } catch (err) {
      setMsg({ step: 2, text: (err as Error).message, bad: true });
    } finally {
      setBusy(null);
    }
  }

  async function linkTelegram() {
    setBusy("tg");
    try {
      const r = await api<{ url: string }>("/api/telegram/link", { method: "POST" });
      window.open(r.url, "_blank", "noopener");
      setMsg({ step: 3, text: "Telegram opened. Press Start in the bot chat; this page updates by itself." });
      watch((w) => w.telegram_linked);
    } catch (err) {
      setMsg({ step: 3, text: (err as Error).message, bad: true });
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return (
      <div className="panel stack">
        <p className="alert alert-bad" role="alert">
          Could not load setup: {error}
        </p>
        <div>
          <button className="btn" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!ws) return <div className="skeleton" style={{ minHeight: 480 }} aria-label="Loading setup" />;

  const connected = Boolean(ws.connected_at);
  const payReady = ws.payment_mode === "vaulted" ? ws.has_vault : true;
  const s1: StepState = connected ? "done" : "current";
  const s2: StepState = !connected ? "todo" : payReady && (ws.has_vault || ws.payment_mode !== "vaulted") ? "done" : "current";
  const s3: StepState = ws.telegram_linked ? "done" : connected ? "current" : "todo";
  const note = (step: number) =>
    msg?.step === step ? (
      <p className={msg.bad ? "alert alert-bad" : "alert"} role={msg.bad ? "alert" : "status"}>
        {msg.text}
      </p>
    ) : null;

  return (
    <div style={{ maxWidth: 680 }}>
      <div className="page-head">
        <div>
          <h1>Setup</h1>
          <p className="muted">Three steps: connect PayPal, choose how agents pay, approve on your phone. Reins never stores card numbers.</p>
        </div>
      </div>

      <ol className="stack-l" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        <li className="panel stack">
          <StepHead n={1} title="Connect PayPal sandbox" state={s1} note="Verified" />
          {connected ? (
            <p className="alert alert-ok">
              Connected · {ws.merchant_email ?? "sandbox merchant"} · {ws.paypal_env === "fake" ? "offline fake PayPal" : "Sandbox"} · oauth2/token 200
            </p>
          ) : (
            <form className="stack" onSubmit={(e) => connect(e, false)}>
              <div className="field">
                <label htmlFor="cid">Client ID</label>
                <input id="cid" className="input" autoComplete="off" value={creds.client_id} onChange={(e) => setCreds({ ...creds, client_id: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="csec">Secret</label>
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <input id="csec" className="input" type={showSecret ? "text" : "password"} autoComplete="off" value={creds.client_secret} onChange={(e) => setCreds({ ...creds, client_secret: e.target.value })} />
                  <button type="button" className="btn" aria-pressed={showSecret} onClick={() => setShowSecret((s) => !s)}>
                    {showSecret ? "Hide" : "Show"}
                  </button>
                </div>
                <span className="hint">Used once to call oauth2/token and kept in server memory only. Never written to the database.</span>
              </div>
              <div className="row">
                <button className="btn btn-primary" disabled={busy === "connect" || !creds.client_id || !creds.client_secret}>
                  {busy === "connect" ? "Checking credentials…" : "Verify"}
                </button>
                <button type="button" className="btn" disabled={busy === "connect"} onClick={() => connect(null, true)}>
                  Use demo merchant (sandbox)
                </button>
              </div>
            </form>
          )}
          {note(1)}
        </li>

        <li className="panel stack" aria-disabled={!connected}>
          <StepHead n={2} title="How agents pay" state={s2} note={ws.payment_mode === "vaulted" ? "Automatic · vault" : ws.payment_mode === "treasury" ? "Treasury" : "Supervised"} />
          <div className="stack-s" role="radiogroup" aria-label="Payment mode">
            <button className="pick" role="radio" aria-checked={ws.payment_mode === "vaulted"} aria-current={ws.payment_mode === "vaulted"} disabled={!connected || busy !== null} onClick={() => (ws.has_vault ? setMode("vaulted") : startVault())}>
              <span className="row between">
                <span className="label">Automatic · PayPal vault</span>
                <span className="caption">$0.01 check</span>
              </span>
              <span className="caption">{ws.has_vault ? "PayPal saved. Agents pay inside their mandate without you." : "Approve a $0.01 verification once; PayPal saves a token you can revoke anytime."}</span>
            </button>
            <button className="pick" role="radio" aria-checked={ws.payment_mode === "supervised"} aria-current={ws.payment_mode === "supervised"} disabled={!connected || busy !== null} onClick={() => setMode("supervised")}>
              <span className="label">Supervised checkout</span>
              <span className="caption">Every approved purchase opens a PayPal checkout you finish yourself.</span>
            </button>
            <button className="pick" role="radio" aria-checked={ws.payment_mode === "treasury"} aria-current={ws.payment_mode === "treasury"} disabled={!connected || busy !== null} onClick={() => setMode("treasury")}>
              <span className="label">Treasury fallback · Payouts</span>
              <span className="caption">Prefund a Reins balance; approved purchases are paid out to the merchant.</span>
            </button>
          </div>
          {connected && ws.payment_mode === "vaulted" && !ws.has_vault && (
            <div>
              <button className="btn btn-primary" onClick={startVault} disabled={busy === "vault"}>
                {busy === "vault" ? "Opening PayPal…" : "Save with PayPal"}
              </button>
            </div>
          )}
          {note(2)}
        </li>

        <li className="panel stack">
          <StepHead n={3} title="Approve on your phone" state={s3} note="Linked" />
          {ws.telegram_linked ? (
            <p className="alert alert-ok">Telegram linked. Approval cards arrive in your chat with @{ws.telegram_bot}.</p>
          ) : (
            <div className="row">
              <button className="btn" onClick={linkTelegram} disabled={!connected || busy === "tg"}>
                <Icon name="link" className="ico-s" /> Link Telegram
              </button>
              <span className="caption">Open @{ws.telegram_bot} and press Start. Optional: the web inbox works without it.</span>
            </div>
          )}
          {note(3)}
        </li>
      </ol>

      <div className="row" style={{ marginTop: 24 }}>
        {connected ? (
          <Link className={s2 === "done" ? "btn btn-primary" : "btn"} href="/agents">
            Continue to agents
          </Link>
        ) : (
          <button className="btn" disabled>
            Continue to agents
          </button>
        )}
      </div>
    </div>
  );
}
