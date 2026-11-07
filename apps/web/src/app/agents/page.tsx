"use client";

import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LedgerRow } from "@reins/core";
import { api } from "@/lib/api";
import { useLive } from "@/lib/live";
import { statusChip, usd } from "@/lib/format";
import { MandateEditor, type MandatePrefill, type MandateView } from "@/components/MandateEditor";
import { Icon } from "@/components/Icon";

interface AgentSummary {
  id: string;
  name: string;
  key_prefix: string;
  revoked: boolean;
  status: "active" | "paused" | "revoked";
  paused_at: string | null;
  key_rotated_at: string | null;
  mandate_version: number | null;
  month_spent_cents: number;
  monthly_limit_cents: number | null;
}
interface Created {
  agent: { id: string; name: string };
  api_key: string;
  mcp_snippet: unknown;
}

const initials = (name: string) =>
  name
    .split(/[\s–-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

function NewAgent({ onCreated, onClose }: { onCreated: (c: Created) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api<Created>("/api/agents", { method: "POST", body: { name } }));
      setName("");
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="stack-s" onSubmit={submit}>
      <label className="label" htmlFor="agent-name">Agent name</label>
      <div className="row">
        <input id="agent-name" style={{ flex: "1 1 100%" }} className="input" autoFocus placeholder="Name your agent" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onClose()} required maxLength={80} />
        <button className="btn btn-primary" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create"}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="alert alert-bad" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<string | null>(null);
  return (
    <>
      <button
        className="btn"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState("Copied");
          } catch {
            setState("Copy failed: select the text manually");
          }
        }}
      >
        {label}
      </button>
      <span role="status" className="caption">
        {state}
      </span>
    </>
  );
}

function KeyOnce({ created, onDone, rotated = false }: { created: Created; onDone: () => void; rotated?: boolean }) {
  const snippet = JSON.stringify(created.mcp_snippet, null, 2);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <section ref={ref} tabIndex={-1} className="panel stack" aria-labelledby="key-once">
      <h2 id="key-once">{rotated ? `New key for ${created.agent.name}` : `Key for ${created.agent.name}`}</h2>
      <p className="alert">
        Shown once. Reins stores only a hash, so copy it now.{rotated ? " The previous key already stopped working: paste this one into the agent's MCP config." : ""}
      </p>
      <div className="code" aria-label="API key">
        {created.api_key}
      </div>
      <div className="row">
        <CopyButton text={created.api_key} label="Copy key" />
        <CopyButton text={snippet} label="Copy MCP snippet" />
      </div>
      <details>
        <summary className="caption">claude_desktop_config.json snippet</summary>
        <div className="code">{snippet}</div>
      </details>
      <div>
        <button className="btn btn-primary" onClick={onDone}>
          {rotated ? "Done, I saved the key" : "Done, write the mandate"}
        </button>
      </div>
    </section>
  );
}

const STATUS_CHIP: Record<AgentSummary["status"], { label: string; className: string }> = {
  active: { label: "Active", className: "status status-ok" },
  paused: { label: "Paused", className: "status status-paused" },
  revoked: { label: "Revoked", className: "status" },
};

const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function AgentCard({ a, selected, onSelect }: { a: AgentSummary; selected: boolean; onSelect: () => void }) {
  const pct = a.monthly_limit_cents ? Math.round((a.month_spent_cents / a.monthly_limit_cents) * 100) : 0;
  return (
    <li>
      <button className="pick" aria-current={selected} onClick={onSelect}>
        <span className="row between">
          <span className="row">
            <span className="status status-info" aria-hidden>
              {initials(a.name)}
            </span>
            <span className="label">{a.name}</span>
          </span>
          <span className={STATUS_CHIP[a.status].className}>{STATUS_CHIP[a.status].label}</span>
        </span>
        {a.monthly_limit_cents != null ? (
          <>
            <span className="caption num">
              {usd(a.month_spent_cents)} / {usd(a.monthly_limit_cents)} · {pct}%
            </span>
            <span className={pct >= 90 ? "bar bad" : pct >= 70 ? "bar warn" : "bar"} aria-hidden>
              <i style={{ width: `${Math.min(pct, 100)}%` }} />
            </span>
          </>
        ) : (
          <span className="caption">No mandate yet · every purchase is denied</span>
        )}
      </button>
    </li>
  );
}

const diffList = (now: string[], before: string[], verb: string) => {
  const added = now.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !now.includes(x));
  return [...(added.length ? [`${verb} ${added.join(", ")}`] : []), ...(removed.length ? [`un-${verb.toLowerCase()} ${removed.join(", ")}`] : [])];
};

/** S2 "Mandate versions": what each version changed against the one before it (v1: created with the agent). */
function versionChanges(v: MandateView, prev: MandateView | undefined): string {
  if (!prev) return "Created with the agent";
  const rules = Object.keys(v.merchant_auto_limits ?? {});
  const prevRules = Object.keys(prev.merchant_auto_limits ?? {});
  const changes = [
    ...diffList(v.blocked_merchants, prev.blocked_merchants, "Blocked"),
    ...diffList(v.allowed_merchants, prev.allowed_merchants, "Allowed"),
    ...rules.filter((m) => !prevRules.includes(m) || prev.merchant_auto_limits?.[m] !== v.merchant_auto_limits?.[m]).map((m) => `Always allow ${m} up to $${v.merchant_auto_limits![m]}`),
    ...prevRules.filter((m) => !rules.includes(m)).map((m) => `Removed rule ${m}`),
    ...(v.monthly_limit !== prev.monthly_limit ? [`Monthly $${prev.monthly_limit} → $${v.monthly_limit}`] : []),
    ...(v.auto_approve_limit !== prev.auto_approve_limit ? [`Auto $${prev.auto_approve_limit} → $${v.auto_approve_limit}`] : []),
    ...(v.per_purchase_cap !== prev.per_purchase_cap ? [`Cap ${prev.per_purchase_cap ? `$${prev.per_purchase_cap}` : "none"} → ${v.per_purchase_cap ? `$${v.per_purchase_cap}` : "none"}`] : []),
    ...(v.purpose !== prev.purpose ? ["Purpose edited"] : []),
    ...(JSON.stringify(v.categories) !== JSON.stringify(prev.categories) ? ["Categories edited"] : []),
  ];
  return changes.length ? changes.join(" · ") : "Saved without changes";
}

const PAYMENT_LINE: Record<string, { on: boolean; text: string }> = {
  vaulted: { on: true, text: "On · PayPal vault. Approved purchases inside the mandate are paid without you." },
  treasury: { on: true, text: "On · Treasury payouts from the prefunded Reins balance." },
  supervised: { on: false, text: "Off · supervised checkout. Every approved purchase waits for you to finish PayPal checkout." },
};

function PaymentLine({ mode }: { mode: string | null }) {
  const line = mode ? PAYMENT_LINE[mode] : null;
  return (
    <section className="row between pay-line" aria-labelledby="pay-h">
      <span className="stack-s" style={{ gap: 2 }}>
        <h3 id="pay-h">Automatic payment</h3>
        <span className="caption">{line ? line.text : "Payment mode unavailable"} Workspace setting, shared by all agents.</span>
      </span>
      <span className="row">
        {line && <span className={line.on ? "status status-ok" : "status"}>{line.on ? "On" : "Off"}</span>}
        <a className="link-48" href="/setup">
          Change in Setup
        </a>
      </span>
    </section>
  );
}

function McpConnection({ agent, onRotated }: { agent: AgentSummary; onRotated: (c: Created) => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const apiUrl = typeof window === "undefined" ? "" : window.location.origin;
  useEffect(() => {
    if (confirm) confirmRef.current?.focus();
  }, [confirm]);
  useEffect(() => {
    setConfirm(false);
    setError(null);
  }, [agent.id]);
  async function rotate() {
    setBusy(true);
    setError(null);
    try {
      onRotated(await api<Created>(`/api/agents/${agent.id}/rotate-key`, { method: "POST" }));
      setConfirm(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  // Same shape the server returns on create/rotate (mcpSnippet in core), with the key masked: the full key is shown once.
  const snippet = JSON.stringify(
    { mcpServers: { reins: { command: "npx", args: ["-y", "tsx", "/ABSOLUTE/PATH/TO/reins/apps/mcp/src/stdio.ts"], env: { REINS_API_KEY: `${agent.key_prefix}…redacted`, REINS_URL: apiUrl } } } },
    null,
    2,
  );
  return (
    <section className="stack-s" aria-labelledby="mcp-h">
      <div className="row between">
        <span className="row">
          <h3 id="mcp-h">MCP connection</h3>
          <span className="key-mask caption mono" aria-label={`Key ${agent.key_prefix}, rest hidden`}>
            <Icon name="shield" className="ico-s" />
            {agent.key_prefix}…redacted
          </span>
        </span>
        <span className="row">
          {agent.status !== "revoked" && (
            <button type="button" className="btn" onClick={() => setConfirm(true)} aria-expanded={confirm} aria-controls="rotate-confirm">
              <Icon name="refresh" className="ico" /> Regenerate
            </button>
          )}
          <CopyButton text={snippet} label="Copy snippet" />
        </span>
      </div>
      {confirm && (
        <div id="rotate-confirm" className="confirm-box" role="group" aria-labelledby="rotate-q">
          <p id="rotate-q">
            <b>Regenerate the key for {agent.name}?</b> The current key ({agent.key_prefix}…) stops working immediately, so the agent fails until you paste the new key into its MCP config. The new key is shown once.
          </p>
          <div className="row">
            <button ref={confirmRef} type="button" className="btn btn-danger" disabled={busy} onClick={rotate}>
              {busy ? "Regenerating…" : "Regenerate key"}
            </button>
            <button type="button" className="btn-link" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="alert alert-bad" role="alert">
          {error}
        </p>
      )}
      <p className="caption mono">
        {agent.key_prefix}… (full key was shown once{agent.key_rotated_at ? `; regenerated ${new Date(agent.key_rotated_at).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}` : " at creation"}; paste it in place of the masked value)
      </p>
      <div className="code">{snippet}</div>
      <p className="caption">Agents only see get_mandate / request_purchase / get_request_status / list_transactions. They never see PayPal credentials. Running from a clone instead? <code>pnpm mcp:stdio</code> starts the same server with these two variables.</p>
    </section>
  );
}

function AgentsScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [rotated, setRotated] = useState<Created | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  // ?agent= is an agent id or a name slug (/agents/research-scout); slugs resolve to ids once the list loads
  const [selected, setSelected] = useState<string | null>(params.get("agent"));
  const [versions, setVersions] = useState<MandateView[] | null>(null);
  /** Older version open in the editor (restore); null = the current one. */
  const [viewId, setViewId] = useState<string | null>(null);
  const [recent, setRecent] = useState<LedgerRow[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [paymentMode, setPaymentMode] = useState<string | null>(null);
  const prefill: MandatePrefill | null =
    params.get("block") || params.get("cap") ? { block: params.get("block")?.split(",").filter(Boolean), cap: params.get("cap") ?? undefined } : null;

  const load = useCallback(() => {
    api<{ agents: AgentSummary[] }>("/api/agents")
      .then((r) => {
        setAgents(r.agents);
        setError(null);
        // entering Agents opens the editor: keep a valid selection, else Research Scout (S2 mockup), else the first agent
        setSelected((s) => {
          const hit = s ? r.agents.find((a) => a.id === s || slugify(a.name) === s) : undefined;
          return (hit ?? r.agents.find((a) => a.name === "Research Scout") ?? r.agents[0])?.id ?? null;
        });
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    api<{ payment_mode: string }>("/api/workspace")
      .then((w) => setPaymentMode(w.payment_mode))
      .catch(() => setPaymentMode(null));
  }, []);
  useLive((e) => {
    if (e.type === "resync" || e.request?.status === "paid") load();
  });

  useEffect(() => {
    if (!selected) return;
    setVersions(null);
    setViewId(null);
    setRecent(null);
    api<{ versions: MandateView[] }>(`/api/agents/${selected}/mandates`)
      .then((r) => setVersions(r.versions))
      .catch((e: Error) => setError(e.message));
    api<{ rows: LedgerRow[] }>(`/api/ledger?agent_id=${selected}&limit=5`)
      .then((r) => setRecent(r.rows))
      .catch(() => setRecent([]));
  }, [selected]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const agent = agents?.find((a) => a.id === selected);
  const viewedIndex = Math.max(0, versions?.findIndex((v) => v.mandate_id === viewId) ?? 0);
  const viewed = versions?.[viewedIndex];

  async function togglePause(a: AgentSummary) {
    setPauseBusy(true);
    try {
      await api(`/api/agents/${a.id}/${a.status === "paused" ? "resume" : "pause"}`, { method: "POST" });
      setToast(a.status === "paused" ? `${a.name} resumed. New requests are checked as usual.` : `${a.name} paused. Its new requests are denied until you resume it.`);
      load();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setPauseBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agents &amp; mandates</h1>
          <p className="muted">Each agent gets its own key and a versioned mandate: caps, merchants and purpose.</p>
        </div>
      </div>

      {rotated && (
        <div style={{ marginBottom: 24 }}>
          <KeyOnce rotated created={rotated} onDone={() => setRotated(null)} />
        </div>
      )}
      {created && (
        <div style={{ marginBottom: 24 }}>
          <KeyOnce
            created={created}
            onDone={() => {
              setSelected(created.agent.id);
              setCreated(null);
            }}
          />
        </div>
      )}

      {error ? (
        <div className="panel stack">
          <p className="alert alert-bad" role="alert">
            {error}
          </p>
          <div>
            <button className="btn" onClick={load}>
              Retry
            </button>
          </div>
        </div>
      ) : (
        <div className="split split-agents">
          <section className="panel panel-tight stack" aria-label="Agents" aria-busy={agents === null}>
            <div className="row between" style={{ flexWrap: "nowrap" }}>
              <h2 className="section-title">Agents {agents ? agents.length : ""}</h2>
              <button type="button" className="btn btn-primary" aria-expanded={newOpen} aria-controls="new-agent" onClick={() => setNewOpen((o) => !o)}>
                <Icon name="plus" className="ico" />
                New agent
              </button>
            </div>
            {newOpen && (
              <div id="new-agent">
                <NewAgent
                  onClose={() => setNewOpen(false)}
                  onCreated={(c) => {
                    setCreated(c);
                    load();
                  }}
                />
              </div>
            )}
            {agents === null ? (
              <div className="stack-s">
                <div className="skeleton" />
                <div className="skeleton" />
                <div className="skeleton" />
              </div>
            ) : agents.length === 0 ? (
              <p className="muted">No agents yet. Create one and paste the MCP snippet into Claude Desktop.</p>
            ) : (
              <ul className="pick-list">
                {agents.map((a) => (
                  <AgentCard
                    key={a.id}
                    a={a}
                    selected={a.id === selected}
                    onSelect={() => {
                      setSelected(a.id);
                      if (prefill) router.replace("/agents");
                    }}
                  />
                ))}
              </ul>
            )}
            {agent && (
              <>
        <section className="stack-s side-block" aria-labelledby="ver-h">
          <h3 id="ver-h">Mandate versions</h3>
          {versions?.length ? (
            <ul className="list">
              {versions.map((v, i) => {
                const rules = Object.entries(v.merchant_auto_limits ?? {});
                return (
                  <li key={v.mandate_id} className={`stack-s ver-item${i === viewedIndex ? " is-viewed" : ""}`} style={{ gap: 2 }}>
                    <span className="label">
                      v{v.version}
                      {i === 0 ? " · current" : ""}
                    </span>
                    <span>{versionChanges(v, versions[i + 1])}</span>
                    <span className="caption">
                      ${v.monthly_limit}/mo · auto ≤ ${v.auto_approve_limit}
                      {v.per_purchase_cap ? ` · cap $${v.per_purchase_cap}` : ""} · blocked {v.blocked_merchants.join(", ") || "none"}
                    </span>
                    {rules.length > 0 && <span className="caption">Always allowed: {rules.map(([m, lim]) => `${m} ≤ $${lim}`).join(", ")}</span>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="caption">No versions yet.</p>
          )}
        </section>
        <section className="stack-s side-block" aria-labelledby="recent-h">
          <h3 id="recent-h">Recent requests</h3>
          {recent === null ? (
            <div className="skeleton" />
          ) : recent.length === 0 ? (
            <p className="caption">No requests yet.</p>
          ) : (
            <ul className="list">
              {recent.map((r) => {
                const chip = statusChip(r);
                return (
                  <li key={r.request_id} className="row between">
                    <span className="row">
                      <span className={chip.className}>{chip.label}</span>
                      <span>{r.merchant}</span>
                    </span>
                    <span className="num">${r.amount}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
              </>
            )}
          </section>

          {agent ? (
            <section className="panel stack-l" aria-labelledby="mandate-h">
              <div className="row between">
                <div className="stack-s">
                  <h2 id="mandate-h">{agent.name}</h2>
                  <span className="caption">Mandate · applies to new requests from this agent</span>
                </div>
                <span className="row">
                  {versions && versions.length > 0 ? (
                    <select
                      className="input select-version"
                      aria-label="Mandate version"
                      value={viewed?.mandate_id ?? ""}
                      onChange={(e) => setViewId(e.target.value === versions[0]!.mandate_id ? null : e.target.value)}
                    >
                      {versions.map((v, i) => (
                        <option key={v.mandate_id} value={v.mandate_id}>
                          v{v.version}
                          {i === 0 ? " · current" : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    agent.mandate_version && <span className="status status-info">v{agent.mandate_version} · current</span>
                  )}
                  {agent.status !== "revoked" && (
                    <button type="button" className="btn" disabled={pauseBusy} onClick={() => togglePause(agent)}>
                      <Icon name={agent.status === "paused" ? "arrow" : "pause"} className="ico" />
                      {agent.status === "paused" ? (pauseBusy ? "Resuming…" : "Resume agent") : pauseBusy ? "Pausing…" : "Pause agent"}
                    </button>
                  )}
                </span>
              </div>
              {agent.status === "paused" && (
                <p className="alert" role="status">
                  Paused{agent.paused_at ? ` since ${new Date(agent.paused_at).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}` : ""}. Every new request from {agent.name} is denied by the
                  “agent paused” hard rule before the auditor or PayPal is called. Pending approvals stay in the inbox.
                </p>
              )}
              {viewedIndex > 0 && viewed && (
                <p className="alert" role="status">
                  Viewing v{viewed.version}, an older version. Saving creates v{(versions?.[0]?.version ?? 0) + 1} with these values; v{versions?.[0]?.version} stays in the history.{" "}
                  <button type="button" className="btn-link" onClick={() => setViewId(null)}>
                    Back to current
                  </button>
                </p>
              )}
              {versions === null ? (
                <div className="skeleton" style={{ minHeight: 320 }} aria-label="Loading mandate" />
              ) : (
                <MandateEditor
                  key={`${viewed?.mandate_id ?? "new"}-${prefill ? "p" : ""}`}
                  agentId={agent.id}
                  current={viewed ?? null}
                  previous={versions[viewedIndex + 1] ?? null}
                  nextVersion={(versions[0]?.version ?? 0) + 1}
                  monthSpentCents={agent.month_spent_cents}
                  prefill={prefill}
                  onSaved={(m) => {
                    setViewId(null);
                    setVersions([m, ...(versions ?? [])]);
                    setToast(`Mandate v${m.version} saved. Applies to new requests.`);
                    if (prefill) router.replace(`/agents?agent=${agent.id}`);
                    load();
                  }}
                  onDiscard={() => prefill && router.replace(`/agents?agent=${agent.id}`)}
                />
              )}
              <PaymentLine mode={paymentMode} />
              <McpConnection
                agent={agent}
                onRotated={(c) => {
                  setRotated(c);
                  load();
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              />
            </section>
          ) : (
            agents && agents.length > 0 && <p className="muted">Select an agent.</p>
          )}
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

export default function AgentsPage() {
  return (
    <Suspense fallback={<div className="skeleton" aria-label="Loading agents" />}>
      <AgentsScreen />
    </Suspense>
  );
}
