"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "@/lib/api";
import { usd } from "@/lib/format";

export interface MandateView {
  mandate_id: string;
  version: number;
  monthly_limit: string;
  auto_approve_limit: string;
  per_purchase_cap: string | null;
  allowed_merchants: string[];
  blocked_merchants: string[];
  categories: string[];
  /** S5 merchant rules from "Approve + always allow": merchant -> auto-approve limit. */
  merchant_auto_limits?: Record<string, string>;
  purpose: string;
  valid_from: string | null;
  valid_until: string | null;
}

/** Fields S6 "Tighten mandate" can prefill (e.g. block fiverr.com, per-purchase cap $60). */
export interface MandatePrefill {
  block?: string[];
  cap?: string;
}

/** "https://www.Fiverr.com/x, statista.com" -> ["www.fiverr.com", "statista.com"] (the server normalizes again). */
export const domains = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, ""))
    .filter(Boolean);
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const toIso = (d: string, end = false) => (d ? new Date(`${d}T${end ? "23:59:59" : "00:00:00"}Z`).toISOString() : null);
const same = (a: string[] | undefined, b: string[] | undefined) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

function Changed({ show, version }: { show: boolean; version: number }) {
  return show ? <span className="status status-info">changed in v{version}</span> : null;
}

/** S2 merchant chips: Enter (or comma/space, or Add) turns the typed domain into a removable chip. */
function DomainChips({
  id,
  label,
  values,
  draft,
  onDraft,
  onChange,
  placeholder,
  hint,
  tone,
}: {
  id: string;
  label: ReactNode;
  values: string[];
  draft: string;
  onDraft: (v: string) => void;
  onChange: (v: string[]) => void;
  placeholder: string;
  hint?: string;
  tone?: "bad";
}) {
  const add = () => {
    const next = [...new Set([...values, ...domains(draft)])];
    if (next.length !== values.length) onChange(next);
    onDraft("");
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {values.length > 0 && (
        <ul className="chips" aria-label={`${typeof label === "string" ? label : id} list`}>
          {values.map((d) => (
            <li key={d}>
              <button type="button" className={tone === "bad" ? "chip-btn chip-domain chip-bad" : "chip-btn chip-domain"} aria-label={`Remove ${d}`} onClick={() => onChange(values.filter((x) => x !== d))}>
                <span className="mono">{d}</span> ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input
          id={id}
          className="input"
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
          }}
          placeholder={placeholder}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <button type="button" className="btn" onClick={add} disabled={!draft.trim()}>
          Add
        </button>
      </div>
      {hint && (
        <span id={`${id}-hint`} className="hint">
          {hint}
        </span>
      )}
    </div>
  );
}

/** M3 / screen S2: amounts, purpose + AI category suggestions, allow/block domains, validity. Saving creates v+1. */
export function MandateEditor({
  agentId,
  current,
  previous,
  monthSpentCents,
  prefill,
  nextVersion,
  onSaved,
  onDiscard,
}: {
  agentId: string;
  current: MandateView | null;
  previous?: MandateView | null;
  monthSpentCents: number;
  prefill?: MandatePrefill | null;
  /** Version a save creates. Differs from current.version + 1 when an older version is open for restoring. */
  nextVersion?: number;
  onSaved: (m: MandateView) => void;
  /** Called after "Discard changes" (the agents page drops a Tighten-mandate prefill from the URL). */
  onDiscard?: () => void;
}) {
  const initial = (withPrefill: boolean) => ({
    monthly_limit: current?.monthly_limit ?? "150.00",
    auto_approve_limit: current?.auto_approve_limit ?? "30.00",
    per_purchase_cap: (withPrefill ? prefill?.cap : undefined) ?? current?.per_purchase_cap ?? "",
    allowed: current?.allowed_merchants ?? [],
    blocked: [...new Set([...(current?.blocked_merchants ?? []), ...((withPrefill ? prefill?.block : undefined) ?? [])])],
    categories: current?.categories ?? [],
    merchantRules: current?.merchant_auto_limits ?? {},
    purpose: current?.purpose ?? "",
    valid_from: day(current?.valid_from ?? null),
    valid_until: day(current?.valid_until ?? null),
  });
  const [form, setForm] = useState(() => initial(true));
  const [allowDraft, setAllowDraft] = useState("");
  const [blockDraft, setBlockDraft] = useState("");
  const dirty = JSON.stringify(form) !== JSON.stringify(initial(false)) || !!allowDraft.trim() || !!blockDraft.trim();
  const [catInput, setCatInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const monthly = Number(form.monthly_limit) || 0;
  const auto = Number(form.auto_approve_limit) || 0;
  const amountsInvalid = auto > monthly;
  const usedPct = monthly > 0 ? Math.min(100, (monthSpentCents / (monthly * 100)) * 100) : 0;
  const v = current?.version ?? 0;
  // diff of the current version against the one before it (S2 "changed in v3" highlight)
  const diff = previous && current
    ? {
        monthly: previous.monthly_limit !== current.monthly_limit,
        auto: previous.auto_approve_limit !== current.auto_approve_limit,
        cap: previous.per_purchase_cap !== current.per_purchase_cap,
        allowed: !same(previous.allowed_merchants, current.allowed_merchants),
        blocked: !same(previous.blocked_merchants, current.blocked_merchants),
        purpose: previous.purpose !== current.purpose,
      }
    : null;

  async function suggest() {
    setSuggesting(true);
    try {
      const r = await api<{ categories: string[] }>("/api/mandates/suggest-categories", { method: "POST", body: { purpose: form.purpose } });
      setForm((f) => ({ ...f, categories: [...new Set([...f.categories, ...r.categories])] }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  }

  function addCategory() {
    const c = catInput.trim().toLowerCase().replace(/\s+/g, "-");
    if (c && !form.categories.includes(c)) setForm({ ...form, categories: [...form.categories, c] });
    setCatInput("");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (amountsInvalid) {
      setError("Monthly cap must be at least the auto-approve limit.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ mandate: MandateView }>(`/api/agents/${agentId}/mandates`, {
        method: "POST",
        body: {
          monthly_limit: form.monthly_limit,
          auto_approve_limit: form.auto_approve_limit,
          per_purchase_cap: form.per_purchase_cap || null,
          // a domain typed but not yet turned into a chip still counts
          allowed_merchants: [...new Set([...form.allowed, ...domains(allowDraft)])],
          blocked_merchants: [...new Set([...form.blocked, ...domains(blockDraft)])],
          categories: form.categories,
          merchant_auto_limits: form.merchantRules,
          purpose: form.purpose,
          valid_from: toIso(form.valid_from),
          valid_until: toIso(form.valid_until, true),
        },
      });
      onSaved(r.mandate);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="stack-l" onSubmit={submit} noValidate aria-describedby={prefill ? "prefill-note" : undefined}>
      {prefill && (
        <p id="prefill-note" className="alert" role="status">
          Suggested from a blocked request: {prefill.block?.length ? `block ${prefill.block.join(", ")}` : ""}
          {prefill.block?.length && prefill.cap ? " · " : ""}
          {prefill.cap ? `per-purchase cap $${prefill.cap}` : ""}. Review and save to create v{v + 1}.
        </p>
      )}
      <div className="field">
        <label htmlFor="m-purpose">
          Purpose <Changed show={!!diff?.purpose} version={v} />
        </label>
        <textarea id="m-purpose" className="input" required value={form.purpose} onChange={set("purpose")} placeholder="Keep developer infrastructure running: domain renewals, hosting and API credits" />
        <div className="row">
          {form.categories.map((c) => (
            <button type="button" key={c} className="chip-btn" aria-pressed="true" aria-label={`Remove category ${c}`} onClick={() => setForm({ ...form, categories: form.categories.filter((x) => x !== c) })}>
              {c} ×
            </button>
          ))}
          <button type="button" className="btn-link" onClick={suggest} disabled={suggesting || !form.purpose.trim()}>
            {suggesting ? "Suggesting…" : "Suggest categories from purpose"}
          </button>
        </div>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <label className="sr-only" htmlFor="m-cat">Add a category</label>
          <input id="m-cat" className="input" value={catInput} onChange={(e) => setCatInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addCategory())} placeholder="Add a category, press Enter" />
          <button type="button" className="btn" onClick={addCategory} disabled={!catInput.trim()}>
            Add
          </button>
        </div>
      </div>

      <div className="grid-3">
        <div className="field">
          <label htmlFor="m-monthly">
            Monthly cap <Changed show={!!diff?.monthly} version={v} />
          </label>
          <div className="money">
            <input id="m-monthly" className="input" inputMode="decimal" required value={form.monthly_limit} onChange={set("monthly_limit")} aria-invalid={amountsInvalid} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="m-auto">
            Auto-approve up to <Changed show={!!diff?.auto} version={v} />
          </label>
          <div className="money">
            <input id="m-auto" className="input" inputMode="decimal" required value={form.auto_approve_limit} onChange={set("auto_approve_limit")} aria-invalid={amountsInvalid} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="m-cap">
            Hard cap per purchase <Changed show={!!diff?.cap || !!prefill?.cap} version={prefill?.cap ? v + 1 : v} />
          </label>
          <div className="money">
            <input id="m-cap" className="input" inputMode="decimal" value={form.per_purchase_cap} onChange={set("per_purchase_cap")} placeholder="none" />
          </div>
        </div>
      </div>
      <div className="stack-s">
        <div className="bar" aria-hidden>
          <i style={{ width: `${usedPct}%` }} />
        </div>
        <p className="caption">
          This month {usd(monthSpentCents)} of ${monthly.toFixed(2)} used · above ${auto.toFixed(2)}, Reins asks you on Telegram and here.
        </p>
      </div>

      <div className="grid-2">
        <div className={diff?.allowed ? "diff-hl" : undefined}>
          <DomainChips
            id="m-allow"
            label={
              <>
                Allowed merchants <Changed show={!!diff?.allowed} version={v} />
              </>
            }
            values={form.allowed}
            draft={allowDraft}
            onDraft={setAllowDraft}
            onChange={(allowed) => setForm((f) => ({ ...f, allowed }))}
            placeholder="Add domain, press Enter"
            hint="Empty means any merchant (the auditor still checks purpose)."
          />
        </div>
        <div className={diff?.blocked || prefill?.block?.length ? "diff-hl" : undefined}>
          <DomainChips
            id="m-block"
            label={
              <>
                Blocked merchants <Changed show={!!diff?.blocked || !!prefill?.block?.length} version={prefill?.block?.length ? v + 1 : v} />
              </>
            }
            values={form.blocked}
            draft={blockDraft}
            onDraft={setBlockDraft}
            onChange={(blocked) => setForm((f) => ({ ...f, blocked }))}
            placeholder="Add domain, press Enter"
            tone="bad"
          />
        </div>
      </div>

      {Object.keys(form.merchantRules).length > 0 && (
        <div className="field">
          <span className="field-label" id="m-rules">
            Always allowed (from approvals)
          </span>
          <div className="row" role="group" aria-labelledby="m-rules">
            {Object.entries(form.merchantRules).map(([m, limit]) => (
              <button
                type="button"
                key={m}
                className="chip-btn"
                aria-pressed="true"
                aria-label={`Remove rule: ${m} up to $${limit}`}
                onClick={() => setForm({ ...form, merchantRules: Object.fromEntries(Object.entries(form.merchantRules).filter(([k]) => k !== m)) })}
              >
                {m} up to ${limit} ×
              </button>
            ))}
          </div>
          <span className="hint">These merchants skip approval up to the amount shown. Caps, block list and the auditor still apply.</span>
        </div>
      )}

      <div className="field">
        <span className="field-label" id="m-valid">Valid from / until (optional)</span>
        <div className="grid-2" role="group" aria-labelledby="m-valid">
          <input type="date" className="input" value={form.valid_from} onChange={set("valid_from")} aria-label="Valid from" />
          <input type="date" className="input" value={form.valid_until} onChange={set("valid_until")} aria-label="Valid until" />
        </div>
      </div>

      {error && (
        <p className="alert alert-bad" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : current ? `Save mandate as v${nextVersion ?? v + 1}` : "Save mandate"}
        </button>
        {current && dirty && (
          <button
            className="btn"
            type="button"
            disabled={saving}
            onClick={() => {
              setForm(initial(false));
              setAllowDraft("");
              setBlockDraft("");
              setCatInput("");
              setError(null);
              onDiscard?.();
            }}
          >
            Discard changes
          </button>
        )}
        <span className="caption">Applies to new requests from this agent.</span>
      </div>
    </form>
  );
}
