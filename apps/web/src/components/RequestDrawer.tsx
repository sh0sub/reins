"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { RequestDetail, TimelineStep } from "@reins/core";
import { api } from "@/lib/api";
import { recordedChip, showKo, statusChip } from "@/lib/format";
import { Icon } from "@/components/Icon";

/** "13:58:02.104" (local), with "Nov 10 " in front when the step is on another day than the request. */
export function msTime(ms: number, firstMs?: number): string {
  const d = new Date(ms);
  const t = `${d.toLocaleTimeString("en-GB", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  if (firstMs != null && new Date(firstMs).toDateString() !== d.toDateString()) {
    return `${d.toLocaleDateString("en-US", { month: "short", day: "2-digit" })} ${t}`;
  }
  return t;
}

const TONE_CLASS: Record<TimelineStep["tone"], string | undefined> = { ok: "ok", bad: "bad", info: undefined, wait: "wait" };

/** Semicircle risk meter 0-10: the filled arc and the number carry the value; colour only repeats the band. */
function RiskGauge({ risk }: { risk: number | null }) {
  const r = 40;
  const len = Math.PI * r;
  const v = risk == null ? 0 : Math.max(0, Math.min(10, risk));
  const band = risk == null ? "none" : v <= 3 ? "ok" : v >= 8 ? "bad" : "warn";
  const word = risk == null ? "No score" : band === "ok" ? "Low risk" : band === "bad" ? "High risk" : "Medium risk";
  return (
    <figure className="gauge" role="img" aria-label={risk == null ? "No risk score" : `Risk ${v} of 10, ${word.toLowerCase()}`}>
      <svg viewBox="0 0 100 58" aria-hidden>
        <path d="M10 50 A40 40 0 0 1 90 50" className="gauge-track" pathLength={len} />
        {risk != null && <path d="M10 50 A40 40 0 0 1 90 50" className={`gauge-fill gauge-${band}`} pathLength={len} strokeDasharray={`${(v / 10) * len} ${len}`} />}
      </svg>
      <figcaption>
        <b className="num">{risk ?? "–"}</b>
        <span className="caption">/10 · {word}</span>
      </figcaption>
    </figure>
  );
}

/** The mandate rules people tune; the basic checks (key, mandate, dates, amount, currency) fold away when they pass. */
const MAIN_RULES = new Set(["per_tx_cap", "monthly_limit", "allowlist", "blocked_merchant", "velocity", "agent_paused"]);

function RulesTable({ rows, caption }: { rows: RequestDetail["hard_rules"]; caption: string }) {
  return (
    <div className="table-wrap">
      <table className="rules">
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          <col style={{ width: "27%" }} />
          <col style={{ width: "30%" }} />
          <col style={{ width: "28%" }} />
          <col style={{ width: "15%" }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Rule</th>
            <th scope="col">Limit</th>
            <th scope="col">Actual</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.rule} className={r.ok ? undefined : "fail"}>
              <th scope="row">{r.label}</th>
              <td data-label="Limit">{r.limit ?? "—"}</td>
              <td data-label="Actual" className={r.ok ? undefined : "bad-text"} title={r.detail}>
                {r.value ?? r.detail}
              </td>
              <td className="res">
                <span className={r.ok ? "status status-ok" : "status status-bad"}>{r.ok ? "pass" : "FAIL"}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * S6 request-detail drawer: right side 520px, full screen under 720px. Esc closes, focus stays inside (trap) and
 * returns to the opener on close. Data: GET /api/ledger/:id/detail.
 */
/** S6 "Model: Claude · 412 tokens · 1.9 s": the model name, then tokens and latency when they were recorded. */
export function modelLine(a: { provider: string | null; tokens: number | null; latency_ms: number | null }): string {
  const p = a.provider ?? "";
  // a real run records "claude:<model id>" (the recorded demo run too): show the model next to the name
  const name = p.startsWith("claude") ? (p.includes(":") ? `Claude (${p.slice(p.indexOf(":") + 1)})` : "Claude") : p === "mock" ? "demo auditor (offline stand-in)" : p;
  return [`Model: ${name}`, a.tokens ? `${a.tokens} tokens` : null, a.latency_ms != null ? `${(a.latency_ms / 1000).toFixed(1)} s` : null].filter(Boolean).join(" · ");
}

export function RequestDrawer({ requestId, onClose, onChanged }: { requestId: string; onClose: () => void; onChanged?: () => void }) {
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const load = useCallback(() => {
    setError(null);
    api<RequestDetail>(`/api/ledger/${requestId}/detail`)
      .then(setDetail)
      .catch(() => setError("Audit log unavailable for this request."));
  }, [requestId]);
  useEffect(() => {
    setDetail(null);
    setNote(null);
    load();
  }, [load]);

  // focus in, scroll lock, focus back to the opener on close
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtn.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, []);

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const list = focusables(panel.current);
    if (!list.length) return;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  async function act(kind: "pause" | "resume" | "expected") {
    if (!detail) return;
    setBusy(kind);
    try {
      if (kind === "pause") {
        await api(`/api/requests/${requestId}/pause-agent`, { method: "POST" });
        setNote(`${detail.agent.name} paused. Its new requests are denied until you resume it.`);
      } else if (kind === "resume") {
        await api(`/api/agents/${detail.agent.id}/resume`, { method: "POST" });
        setNote(`${detail.agent.name} resumed.`);
      } else {
        const r = await api<{ merchant: string; cleared: number }>(`/api/requests/${requestId}/mark-expected`, { method: "POST" });
        setNote(`Marked as expected: unusual-pattern flags cleared on ${r.cleared} ${r.merchant} request${r.cleared === 1 ? "" : "s"}.`);
      }
      load();
      onChanged?.();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const row = detail?.row;
  const chip = row ? statusChip(row) : null;
  const recorded = recordedChip(row?.recorded);
  const failed = detail?.hard_rules.filter((r) => !r.ok) ?? [];
  const mainRules = detail?.hard_rules.filter((r) => !r.ok || MAIN_RULES.has(r.rule)) ?? [];
  const basicRules = detail?.hard_rules.filter((r) => r.ok && !MAIN_RULES.has(r.rule)) ?? [];
  const first = detail?.timeline[0]?.at_ms;
  const capFailed = failed.some((r) => r.rule === "per_tx_cap");
  const tightenHref = row ? `/agents?agent=${row.agent_id}&block=${encodeURIComponent(row.merchant)}${capFailed ? "&cap=60" : ""}` : "#";
  const canTighten = row?.status === "denied" && failed.length > 0 && !failed.every((r) => r.rule === "agent_paused");

  return (
    <div className="drawer-root" onKeyDown={onKeyDown}>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden />
      <div ref={panel} className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={!detail && !error}>
        <header className="drawer-head">
          <div className="stack-s" style={{ gap: 2, minWidth: 0 }}>
            <div className="row">
              <h2 id={titleId} className="mono-title">
                {row?.display_id ?? "Request"}
              </h2>
              {chip && <span className={chip.className}>{chip.label}</span>}
              {recorded && (
                <span className="status status-info" title={recorded.title}>
                  {recorded.label}
                </span>
              )}
            </div>
            {row && (
              <p className="caption drawer-sub">
                {row.agent_name} · {row.items} · {row.merchant} · <b className="num">${row.amount}</b>
              </p>
            )}
          </div>
          <span className="row" style={{ flexWrap: "nowrap" }}>
            <kbd className="hide-s" aria-hidden>
              Esc
            </kbd>
            <button ref={closeBtn} type="button" className="icon-btn" onClick={onClose} aria-label="Close request details">
              <Icon name="x" />
            </button>
          </span>
        </header>

        <div className="drawer-body">
          {error ? (
            <div className="stack-s">
              <p className="alert alert-bad" role="alert">
                {error}
              </p>
              <div>
                <button className="btn" onClick={load}>
                  Retry
                </button>
              </div>
            </div>
          ) : !detail || !row ? (
            <div className="stack" aria-label="Loading request details">
              <div className="skeleton" style={{ minHeight: 160 }} />
              <div className="skeleton" style={{ minHeight: 140 }} />
              <div className="skeleton" />
            </div>
          ) : (
            <>
              <section className="stack-s" aria-labelledby={`${titleId}-tl`}>
                <div className="row between">
                  <h3 id={`${titleId}-tl`} className="section-title">
                    Timeline
                  </h3>
                  <span className="caption">local time, ms</span>
                </div>
                <ol className="timeline timeline-ms">
                  {detail.timeline.map((s) => (
                    <li key={s.key + s.at_ms} className={TONE_CLASS[s.tone]}>
                      <span className="tl-row">
                        <span className="label">{s.label}</span>
                        <time className="mono tl-time" dateTime={s.at}>
                          {msTime(s.at_ms, first)}
                        </time>
                      </span>
                      {s.detail && <span className="caption tl-detail">{s.detail}</span>}
                    </li>
                  ))}
                </ol>
              </section>

              <section className="stack-s" aria-labelledby={`${titleId}-hr`}>
                <div className="row between">
                  <h3 id={`${titleId}-hr`} className="section-title">
                    Hard rules
                  </h3>
                  {detail.hard_rules.length > 0 && <span className={failed.length ? "status status-bad" : "status status-ok"}>{failed.length ? `${failed.length} FAIL` : "ALL PASS"}</span>}
                </div>
                {detail.hard_rules.length ? (
                  <>
                    <RulesTable rows={mainRules} caption={`Hard rules checked for ${row.display_id}`} />
                    {basicRules.length > 0 && (
                      <details className="fold">
                        <summary>
                          <span>{basicRules.length} basic checks passed</span>
                          <span className="caption">key, mandate, dates, amount, currency</span>
                        </summary>
                        <RulesTable rows={basicRules} caption={`Basic checks for ${row.display_id}`} />
                      </details>
                    )}
                  </>
                ) : (
                  <p className="caption">No hard-rule record for this request.</p>
                )}
              </section>

              <section className={`risk-card ${row.risk != null && row.risk >= 8 ? "bad" : ""}`} aria-labelledby={`${titleId}-risk`}>
                <div className="row between">
                  <h3 id={`${titleId}-risk`} className="row" style={{ gap: 6 }}>
                    {row.risk != null && row.risk >= 8 && <Icon name="warn" className="ico" />}
                    {row.risk == null ? "Reins check" : row.risk >= 8 ? "High risk" : row.risk <= 3 ? "Low risk" : "Needs a look"}
                  </h3>
                  {detail.auditor?.provider && (
                    <span className="caption mono">{modelLine(detail.auditor)}</span>
                  )}
                </div>
                <div className="risk-grid">
                  <RiskGauge risk={row.risk} />
                  <div className="stack-s">
                    {detail.auditor?.skipped ? (
                      <p>{detail.auditor.skipped}</p>
                    ) : (
                      <>
                        <p>{detail.auditor?.reason_en ?? row.reason ?? "No auditor reason."}</p>
                        {showKo() && detail.auditor?.reason_ko && (
                          <p className="caption" lang="ko">
                            {detail.auditor.reason_ko}
                          </p>
                        )}
                      </>
                    )}
                    {row.anomalies.length > 0 && <p className="caption">Unusual pattern: {row.anomalies.map((a) => a.detail_en).join("; ")}</p>}
                  </div>
                </div>
              </section>

              <details className="fold">
                <summary>
                  <span>Mandate snapshot</span>
                  {detail.mandate && <span className="status status-info">v{detail.mandate.version}</span>}
                </summary>
                {detail.mandate ? (
                  <dl className="kv">
                    <dt>Purpose</dt>
                    <dd>{detail.mandate.purpose}</dd>
                    <dt>Monthly cap</dt>
                    <dd>${detail.mandate.monthly_limit}</dd>
                    <dt>Auto-approve</dt>
                    <dd>≤ ${detail.mandate.auto_approve_limit}</dd>
                    <dt>Per purchase</dt>
                    <dd>{detail.mandate.per_purchase_cap ? `≤ $${detail.mandate.per_purchase_cap}` : "no cap"}</dd>
                    <dt>Allowed</dt>
                    <dd>{detail.mandate.allowed_merchants.join(", ") || "any merchant"}</dd>
                    <dt>Blocked</dt>
                    <dd>{detail.mandate.blocked_merchants.join(", ") || "none"}</dd>
                  </dl>
                ) : (
                  <p className="caption">This request had no mandate.</p>
                )}
              </details>

              <details className="fold">
                <summary>
                  <span>Raw MCP request</span>
                  <span className="caption mono">request_purchase</span>
                </summary>
                <pre className="code code-dark" tabIndex={0} aria-label="Raw MCP request JSON, agent key redacted">
                  {JSON.stringify(detail.raw_request, null, 2)}
                </pre>
              </details>
            </>
          )}
          {note && (
            <p className="alert alert-ok" role="status">
              {note}
            </p>
          )}
        </div>

        {detail && row && (
          <footer className="drawer-foot">
            {canTighten && (
              <a className="btn btn-primary" href={tightenHref}>
                <Icon name="shield" className="ico" /> Tighten mandate
              </a>
            )}
            {detail.agent.status === "paused" ? (
              <button className="btn" disabled={busy !== null} onClick={() => act("resume")}>
                {busy === "resume" ? "Resuming…" : `Resume ${detail.agent.name}`}
              </button>
            ) : detail.agent.status === "active" ? (
              <button className="btn" disabled={busy !== null} onClick={() => act("pause")}>
                <Icon name="pause" className="ico" /> {busy === "pause" ? "Pausing…" : "Pause agent"}
              </button>
            ) : null}
            {row.anomalies.length > 0 && (
              <button className="btn" disabled={busy !== null} onClick={() => act("expected")} title={`Clears unusual-pattern flags on ${row.agent_name}'s ${row.merchant} requests`}>
                {busy === "expected" ? "Saving…" : "Mark as expected"}
              </button>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
