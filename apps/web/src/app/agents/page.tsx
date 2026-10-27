"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { MandateEditor, type MandateView } from "@/components/MandateEditor";

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

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

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
    <form className="row" onSubmit={submit} style={{ flexWrap: "nowrap" }}>
      <label className="sr-only" htmlFor="agent-name">Agent name</label>
      <input id="agent-name" className="input" placeholder="Claude Code – DevOps" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
      <button className="btn btn-primary" disabled={busy || !name.trim()}>Add agent</button>
      {error && <span className="alert" role="alert">{error}</span>}
    </form>
  );
}

function KeyOnce({ created, onDone }: { created: Created; onDone: () => void }) {
  const snippet = JSON.stringify(created.mcp_snippet, null, 2);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setCopied("Copy failed, select the text manually");
    }
  };
  return (
    <section className="panel stack" aria-labelledby="key-once">
      <h2 id="key-once">Key for {created.agent.name}</h2>
      <p className="alert" style={{ margin: 0 }}>Shown once. Reins stores only a hash, so copy it now.</p>
      <div className="code" aria-label="API key">{created.api_key}</div>
      <div className="row">
        <button className="btn" onClick={() => copy("Key copied", created.api_key)}>Copy key</button>
        <button className="btn" onClick={() => copy("Snippet copied", snippet)}>Copy MCP snippet</button>
        <span role="status" className="caption">{copied}</span>
      </div>
      <details>
        <summary className="caption">claude_desktop_config.json</summary>
        <div className="code">{snippet}</div>
      </details>
      <div><button className="btn btn-primary" onClick={onDone}>Done, set the mandate</button></div>
    </section>
  );
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [versions, setVersions] = useState<MandateView[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ agents: AgentSummary[] }>("/api/agents")
      .then((r) => {
        setAgents(r.agents);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (!selected) return;
    setVersions(null);
    api<{ versions: MandateView[] }>(`/api/agents/${selected}/mandates`).then((r) => setVersions(r.versions)).catch((e: Error) => setError(e.message));
  }, [selected]);

  const agent = agents?.find((a) => a.id === selected);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agents</h1>
          <p className="muted" style={{ margin: 0 }}>Each agent gets its own key and mandate.</p>
        </div>
        <NewAgent onCreated={(c) => { setCreated(c); load(); }} />
      </div>

      {created && (
        <div style={{ marginBottom: 24 }}>
          <KeyOnce created={created} onDone={() => { setSelected(created.agent.id); setCreated(null); }} />
        </div>
      )}

      <section className="panel" aria-busy={agents === null}>
        {error ? (
          <div className="stack"><p className="alert" role="alert">{error}</p><div><button className="btn" onClick={load}>Retry</button></div></div>
        ) : agents === null ? (
          <div className="skeleton" aria-label="Loading agents" />
        ) : agents.length === 0 ? (
          <div className="stack"><h2>No agents yet</h2><p className="muted" style={{ margin: 0 }}>Add one above, then paste the MCP snippet into Claude Desktop.</p></div>
        ) : (
          <ul className="list">
            {agents.map((a) => (
              <li key={a.id} className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <h3>{a.name}</h3>
                  <p className="caption" style={{ margin: 0 }}>
                    {a.key_prefix}… · {a.mandate_version ? `mandate v${a.mandate_version}` : "no mandate"} · {a.monthly_limit_cents != null ? `${usd(a.month_spent_cents)} of ${usd(a.monthly_limit_cents)} this month` : "unlimited until a mandate is set"}
                  </p>
                </div>
                <button className="btn" aria-expanded={selected === a.id} onClick={() => setSelected(selected === a.id ? null : a.id)}>
                  {selected === a.id ? "Close" : a.mandate_version ? "Edit mandate" : "Set mandate"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {agent && (
        <section className="panel stack" style={{ marginTop: 24 }} aria-labelledby="mandate-h">
          <h2 id="mandate-h">Mandate · {agent.name}</h2>
          {versions === null ? (
            <div className="skeleton" aria-label="Loading mandate" />
          ) : (
            <MandateEditor
              key={versions[0]?.mandate_id ?? "new"}
              agentId={agent.id}
              current={versions[0] ?? null}
              onSaved={(m) => { setVersions([m, ...(versions ?? [])]); setSaved(`Saved v${m.version}`); load(); }}
            />
          )}
          {saved && <p role="status" className="caption">{saved}</p>}
          {versions && versions.length > 1 && (
            <details>
              <summary className="caption">Version history ({versions.length})</summary>
              <ul className="list">
                {versions.map((v) => (
                  <li key={v.mandate_id} className="caption">v{v.version}: ${v.monthly_limit}/mo · auto ≤ ${v.auto_approve_limit}{v.per_purchase_cap ? ` · cap $${v.per_purchase_cap}` : ""} · blocked {v.blocked_merchants.join(", ") || "none"}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </>
  );
}
