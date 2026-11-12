"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/** GET /api/try/connect (packages/core playgroundConnect): a per-visitor demo key and the configs that use it. */
interface Connect {
  agent: string;
  api_key: string;
  expires_at: string;
  api_url: string;
  transport: "http" | "stdio";
  mcp_url: string | null;
  /** Public demo: no key, reins-mcp gives each MCP session its own demo key. */
  claude_code_command_keyless?: string | null;
  claude_code_command: string | null;
  mcp_config: unknown;
  mcp_config_local: unknown;
}

/**
 * One GET /api/try/connect per page load, shared by the compact card and the full card (each call issues a demo key and
 * spends the per-IP "connect" bucket). A failure is not cached, so a later mount can retry.
 */
let connectOnce: Promise<Connect> | null = null;
function loadConnect(): Promise<Connect> {
  connectOnce ??= api<Connect>("/api/try/connect").catch((e: unknown) => {
    connectOnce = null;
    throw e;
  });
  return connectOnce;
}

function useConnect(): { info: Connect | null; error: string | null } {
  const [info, setInfo] = useState<Connect | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadConnect()
      .then((c) => live && setInfo(c))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  return { info, error };
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
 * "Connect your agent" (demo instances only), collapsed by default so /try stays short. On the hosted instance the Streamable HTTP MCP
 * config comes first (the keyless Claude Code one-liner on the public demo, then the keyed command + JSON), then curl; the stdio config with its placeholder path is under "Run it locally".
 * The key is this visitor's own (24 h), so other judges' calls never count against its velocity window.
 */
export function ConnectAgent() {
  const { info, error } = useConnect();
  if (error) return null; // not a demo instance: real agents get their own key on the Agents screen
  const stdio = info ? JSON.stringify(info.mcp_config_local, null, 2) : "Loading the demo key…";
  const mcpUrl = info?.mcp_url ?? null;
  const http = info?.transport === "http" ? JSON.stringify(info.mcp_config, null, 2) : null;
  const cli = info?.claude_code_command ?? null;
  const keyless = info?.claude_code_command_keyless ?? null;
  const curl = info
    ? `curl -s ${info.api_url}/api/requests \\\n  -H "Authorization: Bearer ${info.api_key}" -H "Content-Type: application/json" \\\n  -d '{"merchant":"namecheap.com","amount":"12.98","items":"Domain, 1 year","reason":"Landing page"}'`
    : "";
  return (
    <details className="panel stack connect-agent fold-card">
      <summary>
        <h2 id="connect-h" className="h-card">
          Connect your own agent
        </h2>
        <span className="caption">one paste, your own demo key</span>
      </summary>
      <div className="stack">
        <p className="muted">
          Your agent can call <code>request_purchase</code> against this demo wallet. Real agents get their own key on the Agents screen.
        </p>
        <p className="row connect-tags" aria-label="About the key in these snippets">
          <span className="status status-warn">Demo key</span>
          <span className="caption">
            This <code>rk_demo_</code> key is yours alone: it belongs to the throwaway Playground Agent, only your own requests count against its rules (velocity included), it moves no real money and expires after 24 hours.
          </span>
        </p>
        {keyless && (
          <div className="stack-s">
            <div className="row between">
              <b>Claude Code, no key (hosted MCP)</b>
              <Copy text={keyless} label="Copy one-liner" />
            </div>
            <p className="caption">Each MCP session gets its own demo key automatically, so your calls never mix with another judge&apos;s.</p>
            <pre className="mono try-code connect-pre" tabIndex={0} aria-label="claude mcp add command without a key">{keyless}</pre>
          </div>
        )}
        {cli && (
          <div className="stack-s">
            <div className="row between">
              <b>{keyless ? "Or with your demo key" : "Claude Code (hosted MCP)"}</b>
              <Copy text={cli} label="Copy command" />
            </div>
            <pre className="mono try-code connect-pre" tabIndex={0} aria-label="claude mcp add command with your demo key">{cli}</pre>
          </div>
        )}
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
        <div className="stack-s">
          <div className="row between">
            <b>{http ? "Or call the API with curl" : "Paste this in a terminal"}</b>
            {info && <Copy text={curl} label="Copy curl" />}
          </div>
          <pre className="mono try-code connect-pre" tabIndex={0} aria-label="curl command with the demo key">{curl || "…"}</pre>
        </div>
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

/**
 * Always-open card next to the Decision panel (under the judge tour on a phone): the keyless Claude Code one-liner of the
 * public demo, so the strongest path (a real agent over hosted MCP, no key) is visible without scrolling or expanding.
 * Not rendered when there is no keyless command (local or judge instances): the full card below covers those.
 */
export function QuickConnect() {
  const { info } = useConnect();
  const keyless = info?.claude_code_command_keyless ?? null;
  if (!keyless) return null;
  return (
    <section className="panel panel-tight stack-s try-quick" aria-labelledby="quick-h">
      <div className="row between">
        <h2 id="quick-h" className="h-card">
          Use it from Claude Code
        </h2>
        <Copy text={keyless} label="Copy" />
      </div>
      <pre className="mono try-code connect-pre" tabIndex={0} aria-label="claude mcp add command without a key">
        {keyless}
      </pre>
      <p className="caption">One paste, no key: your Claude Code session gets its own demo agent and hits the same rules as this page. More configs under Connect your own agent below.</p>
    </section>
  );
}
