"use client";

import { useState, type FormEvent } from "react";
import { api } from "@/lib/api";

export interface MandateView {
  mandate_id: string;
  version: number;
  monthly_limit: string;
  auto_approve_limit: string;
  per_purchase_cap: string | null;
  allowed_merchants: string[];
  blocked_merchants: string[];
  categories: string[];
  purpose: string;
  valid_from: string | null;
  valid_until: string | null;
}

const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const toIso = (d: string, end = false) => (d ? new Date(`${d}T${end ? "23:59:59" : "00:00:00"}Z`).toISOString() : null);

/** M3: monthly limit, auto-approve limit, per-purchase cap, allow/block domains, categories (AI suggest), purpose, validity. */
export function MandateEditor({ agentId, current, onSaved }: { agentId: string; current: MandateView | null; onSaved: (m: MandateView) => void }) {
  const [form, setForm] = useState({
    monthly_limit: current?.monthly_limit ?? "150.00",
    auto_approve_limit: current?.auto_approve_limit ?? "30.00",
    per_purchase_cap: current?.per_purchase_cap ?? "",
    allowed: (current?.allowed_merchants ?? []).join("\n"),
    blocked: (current?.blocked_merchants ?? []).join("\n"),
    categories: current?.categories ?? [],
    purpose: current?.purpose ?? "",
    valid_from: day(current?.valid_from ?? null),
    valid_until: day(current?.valid_until ?? null),
  });
  const [catInput, setCatInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

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
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ mandate: MandateView }>(`/api/agents/${agentId}/mandates`, {
        method: "POST",
        body: {
          monthly_limit: form.monthly_limit,
          auto_approve_limit: form.auto_approve_limit,
          per_purchase_cap: form.per_purchase_cap || null,
          allowed_merchants: lines(form.allowed),
          blocked_merchants: lines(form.blocked),
          categories: form.categories,
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
    <form className="stack" onSubmit={submit} noValidate>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="m-monthly">Monthly limit (USD)</label>
          <input id="m-monthly" className="input" inputMode="decimal" required value={form.monthly_limit} onChange={set("monthly_limit")} />
        </div>
        <div className="field">
          <label htmlFor="m-auto">Auto-approve up to (USD)</label>
          <input id="m-auto" className="input" inputMode="decimal" required value={form.auto_approve_limit} onChange={set("auto_approve_limit")} aria-describedby="m-auto-hint" />
          <span id="m-auto-hint" className="hint">Above this, you get asked.</span>
        </div>
        <div className="field">
          <label htmlFor="m-cap">Per-purchase cap (USD, optional)</label>
          <input id="m-cap" className="input" inputMode="decimal" value={form.per_purchase_cap} onChange={set("per_purchase_cap")} />
        </div>
        <div className="field">
          <label htmlFor="m-from">Valid from / until (optional)</label>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input id="m-from" type="date" className="input" value={form.valid_from} onChange={set("valid_from")} aria-label="Valid from" />
            <input type="date" className="input" value={form.valid_until} onChange={set("valid_until")} aria-label="Valid until" />
          </div>
        </div>
      </div>
      <div className="field">
        <label htmlFor="m-purpose">Purpose</label>
        <textarea id="m-purpose" className="input" required value={form.purpose} onChange={set("purpose")} placeholder="Keep developer infrastructure running: domain renewals, hosting and API credits" />
      </div>
      <div className="field">
        <label htmlFor="m-cat">Categories</label>
        <div className="row">
          {form.categories.map((c) => (
            <button type="button" key={c} className="status" style={{ minHeight: 32, border: 0, cursor: "pointer" }} aria-label={`Remove ${c}`} onClick={() => setForm({ ...form, categories: form.categories.filter((x) => x !== c) })}>
              {c} ×
            </button>
          ))}
          {form.categories.length === 0 && <span className="hint">None yet</span>}
        </div>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input id="m-cat" className="input" value={catInput} onChange={(e) => setCatInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addCategory())} placeholder="Add a category" />
          <button type="button" className="btn" onClick={addCategory}>Add</button>
          <button type="button" className="btn-link" onClick={suggest} disabled={suggesting || !form.purpose.trim()}>
            {suggesting ? "Suggesting…" : "Suggest from purpose"}
          </button>
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="m-allow">Allowed merchants</label>
          <textarea id="m-allow" className="input" value={form.allowed} onChange={set("allowed")} placeholder={"namecheap.com\nvercel.com"} aria-describedby="m-allow-hint" />
          <span id="m-allow-hint" className="hint">One domain per line. Empty means any merchant.</span>
        </div>
        <div className="field">
          <label htmlFor="m-block">Blocked merchants</label>
          <textarea id="m-block" className="input" value={form.blocked} onChange={set("blocked")} placeholder="fiverr.com" />
        </div>
      </div>
      {error && <p className="alert" role="alert">{error}</p>}
      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : current ? `Save as v${current.version + 1}` : "Save mandate"}
        </button>
        <span className="caption">Applies from the agent&apos;s next request.</span>
      </div>
    </form>
  );
}
