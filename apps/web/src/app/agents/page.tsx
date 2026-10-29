"use client";

import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { LedgerRow } from "@reins/core";
import { api } from "@/lib/api";
import { useLive } from "@/lib/live";
import { statusChip, usd } from "@/lib/format";
import { MandateEditor, type MandatePrefill, type MandateView } from "@/components/MandateEditor";

interface AgentSummary {
  id: string;
  name: string;
  key_prefix: string;
  revoked: boolean;
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

function NewAgent({ onCreated }: { onCreated: (c: Created) => void }) {
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
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="stack-s" onSubmit={submit}>
      <label className="label" htmlFor="agent-name">New agent</label>
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input id="agent-name" className="input" placeholder="Claude Code – DevOps" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        <button className="btn" disabled={busy || !name.trim()}>
          {busy ? "Adding…" : "Add"}
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

function KeyOnce({ created, onDone }: { created: Created; onDone: () => void }) {
  const snippet = JSON.stringify(created.mcp_snippet, null, 2);
  return (
    <section className="panel stack" aria-labelledby="key-once">
      <h2 id="key-once">Key for {created.agent.name}</h2>
      <p className="alert">Shown once. Reins stores only a hash, so copy it now.</p>
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
          Done, write the mandate
        </button>
      </div>
    </section>
  );
}

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
          <span className={a.revoked ? "status" : "status status-ok"}>{a.revoked ? "Revoked" : "Active"}</span>
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

function McpConnection({ agent }: { agent: AgentSummary }) {
  const snippet = JSON.stringify(
    { mcpServers: { reins: { command: "npx", args: ["-y", "tsx", "/ABSOLUTE/PATH/TO/reins/apps/mcp/src/stdio.ts"], env: { REINS_API_URL: "${REINS_API_URL}", REINS_API_KEY: `${agent.key_prefix}…` } } } },
    null,
    2,
  );
  return (
    <section className="stack-s" aria-labelledby="mcp-h">
      <h3 id="mcp-h">MCP connection</h3>
      <p className="caption mono">{agent.key_prefix}… (full key was shown once at creation)</p>
      <div className="code">{snippet}</div>
      <p className="caption">Agents only see get_mandate / request_purchase / get_request_status / list_transactions. They never see PayPal credentials.</p>
    </section>
  );
}

function AgentsScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [selected, setSelected] = useState<string | null>(params.get("agent"));
  const [versions, setVersions] = useState<MandateView[] | null>(null);
  const [recent, setRecent] = useState<LedgerRow[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const prefill: MandatePrefill | null =
    params.get("block") || params.get("cap") ? { block: params.get("block")?.split(",").filter(Boolean), cap: params.get("cap") ?? undefined } : null;

  const load = useCallback(() => {
    api<{ agents: AgentSummary[] }>("/api/agents")
      .then((r) => {
        setAgents(r.agents);
        setError(null);
        setSelected((s) => s ?? r.agents[0]?.id ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useLive((e) => {
    if (e.type === "resync" || e.request?.status === "paid") load();
  });

  useEffect(() => {
    if (!selected) return;
    setVersions(null);
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

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agents &amp; mandates</h1>
          <p className="muted">Each agent gets its own key and a versioned mandate: caps, merchants and purpose.</p>
        </div>
      </div>

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
            <h2 className="section-title">Agents {agents ? agents.length : ""}</h2>
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
            <NewAgent
              onCreated={(c) => {
                setCreated(c);
                load();
              }}
            />
          </section>

          {agent ? (
            <section className="panel stack-l" aria-labelledby="mandate-h">
              <div className="row between">
                <div className="stack-s">
                  <h2 id="mandate-h">{agent.name}</h2>
                  <span className="caption">Mandate · applies to new requests from this agent</span>
                </div>
                {agent.mandate_version && <span className="status status-info">v{agent.mandate_version} · current</span>}
              </div>
              {versions === null ? (
                <div className="skeleton" style={{ minHeight: 320 }} aria-label="Loading mandate" />
              ) : (
                <MandateEditor
                  key={`${versions[0]?.mandate_id ?? "new"}-${prefill ? "p" : ""}`}
                  agentId={agent.id}
                  current={versions[0] ?? null}
                  previous={versions[1] ?? null}
                  monthSpentCents={agent.month_spent_cents}
                  prefill={prefill}
                  onSaved={(m) => {
                    setVersions([m, ...(versions ?? [])]);
                    setToast(`Mandate v${m.version} saved. Applies to new requests.`);
                    if (prefill) router.replace(`/agents?agent=${agent.id}`);
                    load();
                  }}
                />
              )}
              <div className="grid-2">
                <section className="stack-s" aria-labelledby="ver-h">
                  <h3 id="ver-h">Mandate versions</h3>
                  {versions?.length ? (
                    <ul className="list">
                      {versions.map((v, i) => (
                        <li key={v.mandate_id} className="stack-s" style={{ gap: 2 }}>
                          <span className="label">
                            v{v.version}
                            {i === 0 ? " · current" : ""}
                          </span>
                          <span className="caption">
                            ${v.monthly_limit}/mo · auto ≤ ${v.auto_approve_limit}
                            {v.per_purchase_cap ? ` · cap $${v.per_purchase_cap}` : ""} · blocked {v.blocked_merchants.join(", ") || "none"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="caption">No versions yet.</p>
                  )}
                </section>
                <section className="stack-s" aria-labelledby="recent-h">
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
              </div>
              <McpConnection agent={agent} />
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
