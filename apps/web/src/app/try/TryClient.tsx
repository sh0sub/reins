"use client";

import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import Link from "next/link";
import type { LedgerRow } from "@reins/core";
import { api } from "@/lib/api";
import { auditorWord, isSimId, simId, statusChip, usd } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { BLANK, PRESETS, type Preset } from "./presets";
import { runSequence, splitRules, timelineItem, timelineSummary, verdictLine } from "./verdict";

interface Mandate {
  monthly_limit: string;
  auto_approve_limit: string;
  per_purchase_cap: string;
  allowed_merchants: string[];
  purpose: string;
}
interface Result {
  row: LedgerRow;
  auditor: "configured" | "fooled";
  failed_rules: string[];
  paypal: "sandbox" | "simulated" | "none";
}
interface RuleRow {
  rule: string;
  ok: boolean;
  detail: string;
  value?: string;
  limit?: string;
}

const RULE_LABEL: Record<string, string> = {
  agent_active: "Agent key active",
  agent_paused: "Agent not paused",
  mandate_present: "Mandate present",
  mandate_window: "Mandate window",
  amount_valid: "Amount valid",
  currency: "Currency",
  per_tx_cap: "Per-purchase cap",
  merchant_total: "Same merchant, 24 h",
  monthly_limit: "Monthly limit",
  blocked_merchant: "Merchant not blocked",
  allowlist: "Merchant allow list",
  velocity: "Velocity",
};

const rulesOf = (row: LedgerRow): RuleRow[] => (row.decisions.find((d) => d.stage === "hard_rules")?.details as { results?: RuleRow[] } | null)?.results ?? [];

/** Screen "Try": send a purchase request as an AI agent and watch the real policy engine decide. */
export default function TryClient({ enabled, judge, agent, mandate }: { enabled: boolean; judge: boolean; agent: string; mandate: Mandate }) {
  const [fooled, setFooled] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  // a multi-order preset (five $29 orders): every result in order, plus how many are still to come
  const [run, setRun] = useState<{ title: string; total: number; results: Result[] } | null>(null);
  const [form, setForm] = useState(BLANK);
  const [decided, setDecided] = useState<string | null>(null);
  const [tour, setTour] = useState<TourDone>({});
  const [tourOpen, setTourOpen] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const verdictRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(TOUR_KEY) === "1") setTourOpen(false);
    } catch {
      /* storage blocked: the tour just stays open */
    }
  }, []);
  function closeTour(open: boolean) {
    setTourOpen(open);
    try {
      if (open) window.localStorage.removeItem(TOUR_KEY);
      else window.localStorage.setItem(TOUR_KEY, "1");
    } catch {
      /* per-viewer convenience only */
    }
  }
  // after a send the verdict line comes into view (on a phone it sits below the presets; on a desktop the page may be scrolled)
  const [reveal, setReveal] = useState(0);
  useEffect(() => {
    if (!reveal) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    verdictRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: window.innerWidth < 1000 ? "start" : "nearest" });
  }, [reveal]);

  async function send(label: string, purchase: Record<string, string>, key: string, fooledNow = fooled, repeat = 1) {
    setBusy(key);
    setError(null);
    setDecided(null);
    setNote(null);
    setRun(repeat > 1 ? { title: label, total: repeat, results: [] } : null);
    try {
      await runSequence(
        repeat,
        () => api<Result>("/api/try", { method: "POST", body: { ...purchase, fooled_auditor: fooledNow } }),
        (r, i) => {
          setResult(r);
          setTour((t) => tourAfter(t, r));
          if (repeat > 1) setRun((cur) => (cur ? { ...cur, results: [...cur.results, r] } : cur));
          if (i === 1) setReveal((n) => n + 1);
        },
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy("reset");
    setError(null);
    try {
      const r = await api<{ removed_requests: number }>("/api/try/reset", { method: "POST" });
      setResult(null);
      setRun(null);
      setTour({});
      setDecided(null);
      setNote(`Demo data reset: ${r.removed_requests} playground ${r.removed_requests === 1 ? "request" : "requests"} removed. The seeded ledger is untouched.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function submitForm(e: FormEvent) {
    e.preventDefault();
    const purchase: Record<string, string> = { merchant: form.merchant, amount: form.amount, items: form.items, reason: form.reason };
    if (form.category.trim()) purchase.category = form.category.trim();
    void send(form.merchant || "Custom", purchase, "form");
  }

  async function decide(id: string, action: "approve" | "deny") {
    setBusy(action);
    try {
      const row = await api<LedgerRow>(`/api/requests/${id}/decision`, { method: "POST", body: { action } });
      setResult((r) => (r ? { ...r, row } : r));
      setDecided(action === "approve" ? "Approved by you in this playground." : "Rejected by you in this playground.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Try an agent</h1>
          <p className="tagline">You are the AI agent. Send a purchase request and watch Reins pay it, ask you, or block it. This calls the same code path as the MCP tool request_purchase.</p>
        </div>
      </div>

      {enabled && (
        <JudgeTour
          open={tourOpen}
          done={tour}
          busy={busy}
          onOpen={closeTour}
          onSend={(step) => {
            const st = STEPS[step]!;
            const p = PRESETS.find((x) => x.id === st.preset)!;
            if (st.fooled) setFooled(true);
            void send(p.title, p.purchase, p.id, st.fooled ? true : fooled);
          }}
        />
      )}

      {!enabled ? (
        <div className="panel stack" role="note">
          <h2>The playground is off on this server</h2>
          <p className="muted">It creates a demo agent, so it only runs on a demo instance. Start one locally with a throwaway database:</p>
          <pre className="mono try-code" tabIndex={0} aria-label="Command: pnpm judge">pnpm judge</pre>
          <p className="caption">or set REINS_TRY=1 before starting the web app.</p>
        </div>
      ) : (
        <div className="try">
          <div className="stack-l">
            <section className="panel panel-tight stack" aria-labelledby="try-mandate">
              <h2 id="try-mandate" className="h-card row">
                <span className="status status-info" aria-hidden>
                  PA
                </span>
                {agent}
              </h2>
              <p className="caption">Mandate: {mandate.purpose}.</p>
              <ul className="try-limits num">
                <li>
                  <b>${mandate.monthly_limit}</b> per month
                </li>
                <li>
                  <b>${mandate.auto_approve_limit}</b> auto-approve limit
                </li>
                <li>
                  <b>${mandate.per_purchase_cap}</b> per purchase
                </li>
                <li>
                  only <b>{mandate.allowed_merchants.join(", ")}</b>
                </li>
              </ul>
            </section>

            <section className="stack" aria-labelledby="try-presets">
              <h2 id="try-presets" className="h-card">
                Send a request
              </h2>
              <ul className="try-presets">
                {PRESETS.map((p) => (
                  <PresetCard key={p.id} preset={p} busy={busy === p.id} disabled={busy !== null} onSend={() => void send(p.title, p.purchase, p.id, fooled, p.repeat ?? 1)} />
                ))}
              </ul>
              <SendProgress busy={busy !== null && busy !== "reset"} />
              <label className="try-toggle">
                <input type="checkbox" checked={fooled} onChange={(e) => setFooled(e.target.checked)} />
                <span>
                  <b>Simulate a fooled auditor</b> (always says approve)
                  <span className="caption"> Try the $450 order again: the model says yes, the code still says no.</span>
                </span>
              </label>
              <details className="try-free">
                <summary>Write your own request</summary>
                <form className="stack" onSubmit={submitForm}>
                  <div className="grid-2">
                    <div className="field">
                      <label htmlFor="t-merchant">Merchant</label>
                      <input id="t-merchant" className="input" required placeholder="namecheap.com" value={form.merchant} onChange={(e) => setForm({ ...form, merchant: e.target.value })} />
                    </div>
                    <div className="field">
                      <label htmlFor="t-amount">Amount (USD)</label>
                      <input id="t-amount" className="input" required inputMode="decimal" placeholder="25.00" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="t-items">What is being bought</label>
                    <input id="t-items" className="input" required value={form.items} onChange={(e) => setForm({ ...form, items: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="t-reason">Agent&apos;s reason</label>
                    <textarea id="t-reason" className="input" rows={2} required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="t-cat">Category (optional)</label>
                    <input id="t-cat" className="input" placeholder="research" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
                  </div>
                  <div>
                    <button className="btn btn-primary" disabled={busy !== null}>
                      {busy === "form" ? "Sending…" : "Send request"}
                    </button>
                  </div>
                </form>
              </details>
              {judge && (
                <div className="row try-reset">
                  <button type="button" className="btn" disabled={busy !== null} onClick={() => void reset()}>
                    {busy === "reset" ? "Resetting…" : "Reset demo data"}
                  </button>
                  <span className="caption">Removes only what you sent here. The seeded ledger stays.</span>
                </div>
              )}
              {note && (
                <p className="alert alert-ok" role="status">
                  {note}
                </p>
              )}
              <p className="caption">
                Want the real PayPal ids behind the simulated receipts? <Link href="/proof">See the recorded sandbox run</Link>.
              </p>
              <p className="caption">Playground only: the velocity rule (3 requests per 10 minutes) is relaxed so you can click freely. Every other rule is the real one.</p>
            </section>
          </div>

          <section className="stack try-decision" aria-labelledby="try-result" aria-live="polite">
            <h2 id="try-result" className="h-card">
              Decision
            </h2>
            {error && (
              <p className="alert alert-bad" role="alert">
                {error}
              </p>
            )}
            {run && <RunTimeline innerRef={verdictRef} run={run} busy={busy !== null} current={result?.row.request_id ?? null} onPick={setResult} />}
            {!result ? (
              <div className="empty try-empty">
                <p className="muted">{busy ? "Sending…" : "Nothing sent yet. Press Send $12.98 to start."}</p>
              </div>
            ) : (
              <ResultPanel key={result.row.request_id} result={result} busy={busy} decided={decided} verdictRef={run ? undefined : verdictRef} onDecide={(a) => void decide(result.row.request_id, a)} />
            )}
          </section>
        </div>
      )}
    </>
  );
}

/**
 * Under the preset list while a request is in flight. The server answers in one piece (a $59 order waits several seconds on the
 * auditor), so the steps follow what the request goes through, in order, and the only number shown is the real elapsed time.
 */
function SendProgress({ busy }: { busy: boolean }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!busy) {
      setSec(0);
      return;
    }
    const t0 = Date.now();
    const id = setInterval(() => setSec(Math.floor((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(id);
  }, [busy]);
  if (!busy) return <p className="caption try-progress" role="status" aria-live="polite" />;
  const text = sec < 1 ? "Checking hard rules…" : sec < 4 ? "Checking hard rules… asking the auditor…" : "Checking hard rules… asking the auditor… still waiting for its answer (a request that needs a person takes the longest).";
  return (
    <p className="caption try-progress" role="status" aria-live="polite">
      <span className="dot dot-warn try-progress-dot" aria-hidden />
      {text} <span className="num">{sec}s</span>
    </p>
  );
}

function PresetCard({ preset, busy, disabled, onSend }: { preset: Preset; busy: boolean; disabled: boolean; onSend: () => void }) {
  const p = preset.purchase;
  return (
    <li>
      <button type="button" className={preset.id === "injection" ? "pick try-pick bad" : "pick try-pick"} disabled={disabled} onClick={onSend}>
        <span className="row between">
          <span className="label">
            {busy ? "Sending…" : preset.title}
          </span>
          <b className="num">
            {preset.repeat ? `${preset.repeat} × ` : ""}${p.amount}
          </b>
        </span>
        <span className="caption">
          {p.merchant} · {preset.hint}
        </span>
      </button>
    </li>
  );
}

function ResultPanel({
  result,
  busy,
  decided,
  verdictRef,
  onDecide,
}: {
  result: Result;
  busy: string | null;
  decided: string | null;
  verdictRef?: RefObject<HTMLDivElement | null>;
  onDecide: (a: "approve" | "deny") => void;
}) {
  const { row } = result;
  const chip = statusChip(row);
  const rules = rulesOf(row);
  const failed = rules.filter((r) => !r.ok);
  const [allRules, setAllRules] = useState(false);
  const { shown, hidden } = splitRules(rules);
  const visibleRules = allRules ? rules : shown;
  const llm = row.decisions.find((d) => d.stage === "llm");
  const payId = row.payment?.capture_id ?? row.payment?.payout_batch_id ?? row.payment?.order_id ?? null;
  const advisory = Boolean((llm?.details as { advisory?: boolean } | null)?.advisory);
  const fooledButBlocked = result.auditor === "fooled" && row.status === "denied";
  const verdict = verdictLine({ status: row.status, llm: llm ? { decision: llm.decision, actor: llm.actor } : null, rules, auditor: result.auditor, paypal: result.paypal, orderId: row.payment?.order_id ? simId(row.payment.order_id) : null });
  const approveUrl = row.status === "awaiting_buyer" && result.paypal === "sandbox" && /^https:\/\//.test(row.payment?.approve_url ?? "") ? row.payment!.approve_url : null;
  return (
    <div className="panel stack try-result" data-status={row.status}>
      <div ref={verdictRef} className={`try-verdict try-verdict-${verdict.tone}`} role="status">
        <b>{verdict.head}</b> — {verdict.text}
      </div>
      <div className="row between">
        <div className="row">
          <span className={`${chip.className} status-lg`}>{chip.label}</span>
          <b className="num">{usd(Math.round(Number(row.amount) * 100))}</b>
          <span className="muted">{row.merchant}</span>
        </div>
        <span className="caption mono">{row.display_id}</span>
      </div>

      {row.reason && <p>{row.reason}</p>}

      {fooledButBlocked && (
        <p className="alert alert-ok row" role="note">
          <Icon name="shield" className="ico" />
          The simulated auditor said approve. The hard rules ran in code and denied it anyway.
        </p>
      )}

      <div className="stack-s">
        <h3 className="caption kpi-k">Stage 1 · hard rules (code, no model){failed.length ? ` · ${failed.length} failed` : " · all passed"}</h3>
        <table className="try-rules">
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Request</th>
              <th scope="col">Limit</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {visibleRules.map((r) => (
              <tr key={r.rule} className={r.ok ? undefined : "fail"}>
                <th scope="row">{RULE_LABEL[r.rule] ?? r.rule}</th>
                <td className="num">{r.value ?? ""}</td>
                <td className="num">{r.limit ?? ""}</td>
                <td>
                  <span className={r.ok ? "status status-ok" : "status status-bad"}>{r.ok ? "Pass" : "Fail"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {hidden > 0 && (
          <div>
            <button type="button" className="btn-link" aria-expanded={allRules} onClick={() => setAllRules((v) => !v)}>
              {allRules ? "Show only the limits" : `Show all ${rules.length} checks`}
            </button>
            {!allRules && <span className="caption"> · {hidden} basic checks passed (key, mandate, amount, currency…)</span>}
          </div>
        )}
      </div>

      <div className="stack-s">
        <h3 className="caption kpi-k">Stage 2 · auditor{advisory ? " (advisory only, the decision was already final)" : ""}</h3>
        {llm ? (
          <p>
            <span className="status">{result.auditor === "fooled" ? "simulated fooled auditor" : llm.actor === "mock" ? "demo auditor (offline stand-in)" : "Claude"}</span>{" "}
            said <b>{result.auditor === "fooled" ? "approve" : auditorWord(llm.decision)}</b>
            {llm.risk != null ? ` · risk ${llm.risk}/10` : ""}
            {advisory ? (
              <span className="muted"> · ignored: a hard rule had already denied this request, and no auditor answer can override a rule</span>
            ) : (
              result.auditor === "fooled" && llm.decision !== "AUTO_APPROVE" && <span className="muted"> · code capped the answer at {auditorWord(llm.decision)}</span>
            )}{" "}
            {result.auditor !== "fooled" && <span className="muted">{llm.reasonEn}</span>}
          </p>
        ) : (
          <p className="muted">Not called: the rules stopped the request first.</p>
        )}
      </div>

      {row.status === "pending_human" && (
        <div className="stack-s">
          <p className="alert row" role="note">
            <Icon name="inbox" className="ico" />
            Above the auto-approve limit, so a person decides. In the real flow this card goes to Telegram and the web inbox.
          </p>
          <div className="row">
            <button className="btn btn-primary" disabled={busy !== null} onClick={() => onDecide("approve")}>
              {busy === "approve" ? "Approving…" : "Approve"}
            </button>
            <button className="btn btn-danger" disabled={busy !== null} onClick={() => onDecide("deny")}>
              Reject
            </button>
          </div>
        </div>
      )}
      {decided && <p className="alert alert-ok" role="status">{decided}</p>}

      {payId && (
        <p className="row">
          <span className="caption">PayPal</span>
          <span className="mono">{simId(payId)}</span>
          {isSimId(payId) ? <span className="status status-info">simulated</span> : <span className="status status-ok">sandbox</span>}
        </p>
      )}
      {approveUrl && (
        <p className="alert row" role="note">
          <Icon name="shield" className="ico" />
          <span>
            Approved by Reins. The real PayPal sandbox order is created; in supervised checkout the buyer approves it on PayPal as the last step, so it shows as Checkout open until then.{" "}
            <a href={approveUrl} target="_blank" rel="noopener noreferrer">
              Open the PayPal sandbox approval page
            </a>
          </span>
        </p>
      )}
      <div className="row">
        <Link className="btn" href={`/ledger?r=${row.request_id}&drawer=1`}>
          Open in the ledger
        </Link>
        {row.status === "paid" && row.receipt?.receipt_url && (
          <Link className="btn" href={`/receipts/${row.display_id}`}>
            Receipt
          </Link>
        )}
      </div>
    </div>
  );
}

/** Five $29 orders: one row per order as each decision lands (Paid, Paid, Paid, Denied, Denied), with the rule that stopped it. */
function RunTimeline({
  run,
  busy,
  current,
  innerRef,
  onPick,
}: {
  run: { title: string; total: number; results: Result[] };
  busy: boolean;
  current: string | null;
  innerRef?: RefObject<HTMLDivElement | null>;
  onPick: (r: Result) => void;
}) {
  const items = run.results.map((r, i) => timelineItem(i + 1, { status: r.row.status, rules: rulesOf(r.row) }));
  const left = run.total - run.results.length;
  return (
    <div ref={innerRef} className="panel panel-tight stack-s try-run" role="status">
      <div className="row between">
        <b>
          {run.title} · {run.results.length} of {run.total} sent
        </b>
        {items.length > 0 && <span className="caption">{timelineSummary(items)}</span>}
      </div>
      <ol className="try-run-list">
        {items.map((it, i) => {
          const r = run.results[i]!;
          return (
            <li key={r.row.request_id}>
              <button type="button" className="try-run-row" aria-current={current === r.row.request_id ? "true" : undefined} onClick={() => onPick(r)}>
                <span className="try-run-n num">{it.n}</span>
                <span className="num">{usd(Math.round(Number(r.row.amount) * 100))}</span>
                <span className={`status status-${it.tone}`}>{it.label}</span>
                <span className="caption mono">{r.row.display_id}</span>
                {it.reason && <span className="try-run-why caption">{it.reason}</span>}
              </button>
            </li>
          );
        })}
        {busy &&
          Array.from({ length: left }, (_, k) => (
            <li key={`wait-${k}`} className="try-run-row is-wait" aria-hidden>
              <span className="try-run-n num">{run.results.length + k + 1}</span>
              <span className="caption">{k === 0 ? "Sending…" : "Queued"}</span>
            </li>
          ))}
      </ol>
      {!current && <p className="caption">Select an order to see its decision below.</p>}
    </div>
  );
}

const TOUR_KEY = "reins.judgeTour.closed";
type TourDone = Partial<Record<0 | 1 | 2, string>>;
const TOUR_SHORT = ["$12.98 pays", "$59 asks you", "$450 is denied"];
const STEPS: Array<{ title: string; preset: Preset["id"]; fooled?: boolean; button: string; expect: string }> = [
  { title: "Send $12.98", preset: "domain", button: "Send $12.98", expect: "It is small and on the allow list, so it pays with no one asked." },
  { title: "Send $59", preset: "report", button: "Send $59", expect: "It is above the $30 auto-approve limit, so it waits for you." },
  { title: "Send $450 with the fooled-auditor toggle", preset: "injection", fooled: true, button: "Send $450, fooled auditor", expect: "The simulated auditor says yes. The hard rules still deny it, in code." },
];

/** Which tour step a finished request completes (value = request id, used for the closing links). */
function tourAfter(t: TourDone, r: Result): TourDone {
  const amount = Number(r.row.amount);
  const id = r.row.request_id;
  // supervised checkout on the real sandbox stops at "awaiting_buyer": approved by Reins without asking anyone counts too
  if (amount === 12.98 && (r.row.status === "paid" || r.row.status === "awaiting_buyer")) return { ...t, 0: id };
  if (amount === 59 && r.row.status === "pending_human") return { ...t, 1: id };
  if (amount === 450 && r.auditor === "fooled" && r.row.status === "denied") return { ...t, 2: id };
  return t;
}

function JudgeTour({ open, done, busy, onOpen, onSend }: { open: boolean; done: TourDone; busy: string | null; onOpen: (open: boolean) => void; onSend: (step: 0 | 1 | 2) => void }) {
  if (!open) {
    return (
      <p className="caption">
        <button type="button" className="linklike" onClick={() => onOpen(true)}>
          Show the judge tour
        </button>
      </p>
    );
  }
  const count = ([0, 1, 2] as const).filter((i) => done[i]).length;
  const next = ([0, 1, 2] as const).find((i) => !done[i]);
  if (count > 0) {
    // after step 1 the tour shrinks to one row so the decision stays above the fold
    const nextStep = next === undefined ? null : STEPS[next]!;
    return (
      <section className="panel panel-tight tour tour-compact" aria-labelledby="tour-h">
        <h2 id="tour-h" className="h-card">
          Judge tour <span className="muted">· {count} of 3 done</span>
        </h2>
        <ol className="tour-pills">
          {STEPS.map((st, i) => (
            <li key={st.title} className={done[i as 0 | 1 | 2] ? "tour-pill is-done" : i === next ? "tour-pill is-next" : "tour-pill"}>
              <span className="tour-mark" aria-hidden>
                {done[i as 0 | 1 | 2] ? <Icon name="check" className="ico-s" /> : i + 1}
              </span>
              <span>
                {TOUR_SHORT[i]}
                {done[i as 0 | 1 | 2] && <span className="sr-only"> (done)</span>}
              </span>
            </li>
          ))}
        </ol>
        <span className="row tour-acts">
          {nextStep && next !== undefined && (
            <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => onSend(next)}>
              {nextStep.button}
            </button>
          )}
          {done[1] && (
            <Link className="btn" href="/inbox?playground=1">
              Open Approvals
            </Link>
          )}
          <button type="button" className="btn" onClick={() => onOpen(false)}>
            Dismiss
          </button>
        </span>
        {nextStep && <p className="caption tour-expect">{nextStep.expect}</p>}
        {count === 3 && (
          <p className="alert alert-ok row tour-done" role="status">
            <Icon name="shield" className="ico" />
            <span>
              Done: one paid, one asked a person, one denied by code. See the <Link href={`/ledger?r=${done[2]}`}>ledger row</Link> and its <Link href={`/ledger?r=${done[2]}&drawer=1`}>audit trail</Link>, or the{" "}
              <Link href="/proof">recorded PayPal sandbox run</Link>.
            </span>
          </p>
        )}
      </section>
    );
  }
  return (
    <section className="panel stack tour" aria-labelledby="tour-h">
      <div className="row between">
        <h2 id="tour-h" className="h-card">
          Judge tour <span className="muted">· {count} of 3 done</span>
        </h2>
        <button type="button" className="btn" onClick={() => onOpen(false)}>
          Dismiss
        </button>
      </div>
      <ol className="tour-steps">
        {STEPS.map((st, i) => {
          const idx = i as 0 | 1 | 2;
          const id = done[idx];
          return (
            <li key={st.title} className={id ? "tour-step is-done" : idx === next ? "tour-step is-next" : "tour-step"}>
              <span className="tour-mark" aria-hidden>
                {id ? <Icon name="check" className="ico-s" /> : i + 1}
              </span>
              <div className="stack-s">
                <b>
                  {st.title}
                  {id && <span className="sr-only"> (done)</span>}
                </b>
                <span className="caption">{st.expect}</span>
                <span className="row">
                  <button type="button" className={idx === next ? "btn btn-primary" : "btn"} disabled={busy !== null} onClick={() => onSend(idx)}>
                    {id ? "Send again" : st.button}
                  </button>
                  {idx === 1 && id && (
                    <Link className="btn" href="/inbox?playground=1">
                      Open Approvals
                    </Link>
                  )}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      {count === 3 && (
        <p className="alert alert-ok row" role="status">
          <Icon name="shield" className="ico" />
          <span>
            Done: one paid, one asked a person, one denied by code. See the{" "}
            <Link href={`/ledger?r=${done[2]}`}>ledger row</Link> and its <Link href={`/ledger?r=${done[2]}&drawer=1`}>audit trail</Link>, or the <Link href="/proof">recorded PayPal sandbox run</Link>.
          </span>
        </p>
      )}
    </section>
  );
}
