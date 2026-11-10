"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { searchPalette, type PaletteItem, type ShellAgent, type ShellRequest } from "@/lib/shell";

const KIND_LABEL: Record<PaletteItem["kind"], string> = { page: "Page", agent: "Agent", request: "Request" };

/** Top-bar search field + Cmd/Ctrl+K command palette over pages, agents and requests. */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [data, setData] = useState<{ agents: ShellAgent[]; requests: ShellRequest[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQ("");
    setSel(0);
    opener.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    setFailed(false);
    Promise.all([api<{ agents: ShellAgent[] }>("/api/agents"), api<{ rows: ShellRequest[] }>("/api/ledger?limit=500")])
      .then(([a, l]) => setData({ agents: a.agents, requests: l.rows }))
      .catch(() => setFailed(true));
  }, [open]);

  const items = useMemo(() => searchPalette(q, data?.agents ?? [], data?.requests ?? []), [q, data]);
  const go = (it: PaletteItem | undefined) => {
    if (!it) return;
    setOpen(false);
    setQ("");
    setSel(0);
    router.push(it.href);
  };

  return (
    <>
      <button ref={opener} type="button" className="cmdk-trigger" aria-label="Search requests and agents" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K">
        <svg viewBox="0 0 24 24" className="ico" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="6.5" />
          <path d="M16 16l4.5 4.5" />
        </svg>
        <span className="cmdk-ph">Search requests, agents…</span>
        <kbd>⌘K</kbd>
      </button>
      {open && (
        <div className="cmdk-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <div className="cmdk" role="dialog" aria-modal="true" aria-label="Search requests and agents">
            <input
              ref={input}
              className="cmdk-input"
              role="combobox"
              aria-expanded
              aria-controls="cmdk-list"
              aria-activedescendant={items[sel] ? `cmdk-${sel}` : undefined}
              placeholder="Search requests, agents…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSel(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") close();
                else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel((s) => Math.min(s + 1, items.length - 1));
                }
                else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((s) => Math.max(s - 1, 0));
                }
                else if (e.key === "Enter") {
                  e.preventDefault();
                  go(items[sel]);
                }
              }}
            />
            <ul className="cmdk-list" id="cmdk-list" role="listbox">
              {items.map((it, i) => (
                <li key={`${it.kind}-${it.id}`} id={`cmdk-${i}`} role="option" aria-selected={i === sel} className="cmdk-item" onMouseEnter={() => setSel(i)} onClick={() => go(it)}>
                  <span className="status">{KIND_LABEL[it.kind]}</span>
                  <span className="cmdk-label">{it.label}</span>
                  <span className="caption cmdk-hint">{it.hint}</span>
                </li>
              ))}
            </ul>
            {items.length === 0 && <p className="caption cmdk-empty">{data || failed ? `No match for "${q}".` : "Loading…"}</p>}
            {failed && <p className="caption cmdk-empty">Requests could not be loaded. Pages and agents still work.</p>}
            <div className="cmdk-foot caption">
              <span><kbd>↑</kbd> <kbd>↓</kbd> move</span>
              <span><kbd>Enter</kbd> open</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
