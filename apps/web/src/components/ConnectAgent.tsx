"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Connect {
  agent: string;
  api_key: string;
  api_url: string;
  mcp_config: unknown;
}

/** One copy button per block; a failed clipboard write says so instead of staying silent. */
function Copy({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<string | null>(null);
  return (
    <span className="row">
      <button
        type="button"
        className="btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState("Copied");
          } catch {
            setState("Copy failed: select the text");
          }
        }}
      >
        {label}
      </button>
      <span role="status" className="caption">
        {state}
      </span>
    </span>
  );
}

/** "Connect your agent": a copy-paste MCP config and a 3-line curl, pre-filled with the demo key (demo instances only). */
export function ConnectAgent() {
  const [info, setInfo] = useState<Connect | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Connect>("/api/try/connect").then(setInfo).catch((e: Error) => setError(e.message));
  }, []);
  if (error) return null; // not a demo instance: real agents get their own key on the Agents screen
  const mcp = info ? JSON.stringify(info.mcp_config, null, 2) : "Loading the demo key…";
  const curl = info
    ? `curl -s ${info.api_url}/api/requests \\\n  -H "Authorization: Bearer ${info.api_key}" -H "Content-Type: application/json" \\\n  -d '{"merchant":"namecheap.com","amount":"12.98","items":"Domain, 1 year","reason":"Landing page"}'`
    : "";
  return (
    <section className="panel stack connect-agent" aria-labelledby="connect-h">
      <div className="stack-s">
        <h2 id="connect-h" className="h-card">
          Connect your agent
        </h2>
        <p className="muted">
          Paste this into Claude Desktop (or any MCP client) and your agent can call <code>request_purchase</code> against this demo wallet. The key belongs to the throwaway Playground Agent. Real agents get their own key on the Agents screen.
        </p>
      </div>
      <div className="stack-s">
        <div className="row between">
          <b>MCP config</b>
          {info && <Copy text={mcp} label="Copy MCP config" />}
        </div>
        <pre className="mono try-code connect-pre">{mcp}</pre>
        <p className="caption">Replace /ABSOLUTE/PATH/TO/reins with your clone. No clone? The same four tools are also plain HTTP:</p>
      </div>
      <div className="stack-s">
        <div className="row between">
          <b>or curl</b>
          {info && <Copy text={curl} label="Copy curl" />}
        </div>
        <pre className="mono try-code connect-pre">{curl || "…"}</pre>
        <p className="caption">
          No agent at hand? Run <code>pnpm judge:agent</code> in a second terminal: a small script that reads a poisoned page and shows PAID, PENDING and DENIED. The npm package is still roadmap.
        </p>
      </div>
    </section>
  );
}
