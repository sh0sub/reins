"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { hostedMcpUrl } from "@/lib/shell";

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

/**
 * "Connect your agent" (demo instances only), collapsed by default so /try stays short. One paste first (curl), then the Streamable HTTP
 * MCP config when a hosted MCP server exists, and the stdio config with its placeholder path under "Run it locally".
 */
export function ConnectAgent() {
  const [info, setInfo] = useState<Connect | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Connect>("/api/try/connect").then(setInfo).catch((e: Error) => setError(e.message));
  }, []);
  if (error) return null; // not a demo instance: real agents get their own key on the Agents screen
  const stdio = info ? JSON.stringify(info.mcp_config, null, 2) : "Loading the demo key…";
  const mcpUrl = info ? hostedMcpUrl(info.api_url) : null;
  const http = info && mcpUrl ? JSON.stringify({ mcpServers: { reins: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${info.api_key}` } } } }, null, 2) : null;
  const curl = info
    ? `curl -s ${info.api_url}/api/requests \\\n  -H "Authorization: Bearer ${info.api_key}" -H "Content-Type: application/json" \\\n  -d '{"merchant":"namecheap.com","amount":"12.98","items":"Domain, 1 year","reason":"Landing page"}'`
    : "";
  return (
    <details className="panel stack connect-agent fold-card">
      <summary>
        <h2 id="connect-h" className="h-card">
          Connect your own agent
        </h2>
        <span className="caption">one paste, demo key</span>
      </summary>
      <div className="stack">
        <p className="muted">
          Your agent can call <code>request_purchase</code> against this demo wallet. Real agents get their own key on the Agents screen.
        </p>
        <p className="row connect-tags" aria-label="About the key in these snippets">
          <span className="status status-warn">Demo key</span>
          <span className="caption">
            Every Reins key starts with <code>rk_live_</code>, so this one looks live. It is not: it belongs to the throwaway Playground Agent, moves no money and dies with the demo.
          </span>
        </p>
        <div className="stack-s">
          <div className="row between">
            <b>Paste this in a terminal</b>
            {info && <Copy text={curl} label="Copy curl" />}
          </div>
          <pre className="mono try-code connect-pre" tabIndex={0} aria-label="curl command with the demo key">{curl || "…"}</pre>
        </div>
        {http && (
          <div className="stack-s">
            <div className="row between">
              <b>MCP config (Streamable HTTP)</b>
              <Copy text={http} label="Copy MCP config" />
            </div>
            <p className="caption">
              For Claude Code, Claude Desktop or any MCP client that speaks HTTP: <code>{mcpUrl}</code>, key in the <code>Authorization: Bearer</code> header.
            </p>
            <pre className="mono try-code connect-pre" tabIndex={0} aria-label="Streamable HTTP MCP config with the demo key">{http}</pre>
          </div>
        )}
        <details className="fold">
          <summary>
            <span>Run it locally (stdio)</span>
            <span className="caption">needs a clone</span>
          </summary>
          <div className="stack-s">
            <div className="row between">
              <p className="row connect-tags">
                <span className="status">Placeholder path</span>
                <span className="caption">
                  <code>/ABSOLUTE/PATH/TO/reins</code> is not a real path: replace it with your clone.
                </span>
              </p>
              {info && <Copy text={stdio} label="Copy stdio config" />}
            </div>
            <pre className="mono try-code connect-pre" tabIndex={0} aria-label="stdio MCP config with the demo key and a placeholder path">{stdio}</pre>
          </div>
        </details>
        <p className="caption">
          No agent at hand? Run <code>pnpm judge:agent</code> in a second terminal: a small script that reads a poisoned page and shows paid, pending and denied. The npm package is still roadmap.
        </p>
      </div>
    </details>
  );
}
