/**
 * Terminal replay page for the real-mode demo video (scripts/demo/record-video-real.mjs). Input: the stream-json log of a
 * REAL `claude -p ... --output-format stream-json --verbose` session against the hosted Reins MCP. Every line shown comes
 * from that log (tool names, arguments, result fields, Claude's text); only the pacing is compressed, and the page says so.
 * Claude Code's internal ToolSearch step (loading the deferred MCP tool schemas) is left out.
 */
import { readFileSync } from "node:fs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const resultText = (c) => (Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join("") : String(c.content ?? ""));

function fmtArgs(name, input) {
  if (name === "get_mandate") return "";
  if (name === "get_request_status") return `request_id: "${input.request_id}"`;
  if (name === "request_purchase") return `merchant: "${input.merchant}", amount: "${input.amount}", items: "${input.items}", category: "${input.category}"`;
  return Object.entries(input).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
}

function fmtResult(name, text) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return { cls: "dim", text: text.trim() || "(no output)" };
  }
  if (name === "get_mandate") {
    const m = d.mandate;
    return { cls: "dim", text: `${d.agent.name} · mandate v${m.version} · auto-approve ≤ $${m.auto_approve_limit} · ≤ $${m.per_purchase_cap} per purchase · $${m.monthly_limit}/month · allowed: ${m.allowed_merchants.join(", ")}` };
  }
  const parts = [`${d.display_id}`, `status: ${d.status}`, `decision: ${d.decision}`, `risk ${d.risk}`];
  if (d.receipt?.capture_id) parts.push(`PayPal ID ${d.receipt.capture_id}`);
  return { cls: d.status === "paid" ? "ok" : d.status === "denied" ? "bad" : "warn", text: parts.join(" · ") };
}

/** Parses the log into display events (in order). */
export function sessionEvents(jsonlPath) {
  const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const names = new Map();
  const events = [];
  let model = "";
  let durationMs = 0;
  for (const m of lines) {
    if (m.type === "system" && m.subtype === "init") model = m.model;
    if (m.type === "result") durationMs = m.duration_ms;
    if (m.type === "assistant") {
      for (const c of m.message.content) {
        if (c.type === "text" && c.text.trim()) events.push({ kind: "text", text: c.text.trim() });
        if (c.type === "tool_use") {
          names.set(c.id, c.name);
          if (c.name === "ToolSearch") continue;
          if (c.name === "Bash") events.push({ kind: "call", text: `Bash(${c.input.command})` });
          else events.push({ kind: "call", text: `reins · ${c.name.replace("mcp__reins__", "")}(${fmtArgs(c.name.replace("mcp__reins__", ""), c.input)})` });
        }
      }
    }
    if (m.type === "user") {
      for (const c of m.message.content) {
        if (c.type !== "tool_result") continue;
        const name = names.get(c.tool_use_id) ?? "";
        if (name === "ToolSearch") continue;
        const r = name === "Bash" ? { cls: "dim", text: "(no output)" } : fmtResult(name.replace("mcp__reins__", ""), resultText(c));
        events.push({ kind: "result", ...r });
      }
    }
  }
  const last = [...lines].reverse().flatMap((m) => (m.type === "user" ? m.message.content : [])).find((c) => c.type === "tool_result" && resultText(c).includes('"receipt"'));
  const paid = last ? JSON.parse(resultText(last)) : null;
  const request = paid?.status === "paid" ? { id: paid.request_id, display: paid.display_id, paypal: paid.receipt.capture_id } : null;
  return { events, model, durationMs, request };
}

/**
 * Full-page terminal (CSS viewport size). window.play({ cmd2At, eventsAt, endAt }) types the setup line at 0, the claude
 * command at cmd2At, then reveals the events evenly between eventsAt and endAt (seconds).
 */
export function termHtml({ jsonlPath, setupCmd, runCmd, mcpUrl, w, h }) {
  const { events, model, durationMs } = sessionEvents(jsonlPath);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:#0b1020;-webkit-font-smoothing:antialiased}
  .win{position:absolute;inset:0;display:flex;flex-direction:column}
  .bar{flex:none;display:flex;align-items:center;gap:10px;height:44px;padding:0 18px;background:#161d33;color:#9fb0d9;font:600 15px/1 -apple-system,Helvetica,Arial,sans-serif;border-bottom:1px solid #26304f}
  .bar i{display:block;width:12px;height:12px;border-radius:50%}
  .bar .t{margin-left:10px}
  .scr{flex:1;overflow:hidden;padding:20px 30px 120px;font:17px/1.55 Menlo,Monaco,monospace;color:#e5e9f5}
  .ln{white-space:pre-wrap;word-break:break-word;margin:0 0 8px}
  .p{color:#4ade80}.cmt{color:#7c89ad}.cmd{color:#f8fafc}
  .call{color:#93c5fd}.call b{color:#fbbf24;font-weight:400}
  .res{color:#9aa6c4;padding-left:26px}.res.ok{color:#4ade80}.res.warn{color:#fbbf24}.res.bad{color:#f87171}
  .txt{color:#f1f5f9}.txt b{color:#e2e8f0}
  .hidden{display:none}
  .hl{background:rgba(74,222,128,.14);outline:1px solid rgba(74,222,128,.55);border-radius:6px;padding:2px 8px;margin-left:-8px}
  .cur{display:inline-block;width:9px;height:19px;background:#e5e9f5;vertical-align:-3px;animation:bl 1s steps(1) infinite}
  @keyframes bl{50%{opacity:0}}
  .tag{position:absolute;right:16px;top:7px;padding:7px 14px !important;background:rgba(22,29,51,.95);border:1px solid #3b4a78;color:#c7d2fe;border-radius:999px;font:600 14px/1 -apple-system,Helvetica,Arial,sans-serif}
  </style></head><body><div class="win">
  <div class="bar"><i style="background:#f87171"></i><i style="background:#fbbf24"></i><i style="background:#4ade80"></i><span class="t">Claude Code · model ${esc(model)} · Reins MCP at ${esc(mcpUrl)}</span></div>
  <div class="scr" id="scr">
    <div class="ln"><span class="p">$ </span><span class="cmd" id="c1"></span><span class="cur" id="cur1"></span></div>
    <div class="ln cmt hidden" id="c1n"># one-time setup, no API key. This recording passed the same server in a file:</div>
    <div class="ln cmt hidden" id="c1m">#   mcp.json = {"mcpServers":{"reins":{"type":"http","url":"${esc(mcpUrl)}"}}}</div>
    <div class="ln hidden" id="l2"><span class="p">$ </span><span class="cmd" id="c2"></span><span class="cur hidden" id="cur2"></span></div>
    ${events
      .map((e, i) => {
        if (e.kind === "call") return `<div class="ln call hidden" data-ev="${i}">⏺ <b>${esc(e.text.split("(")[0])}</b>(${esc(e.text.slice(e.text.indexOf("(") + 1, -1))})</div>`;
        if (e.kind === "result") return `<div class="ln res ${e.cls} hidden" data-ev="${i}">⎿ ${esc(e.text)}</div>`;
        return `<div class="ln txt hidden" data-ev="${i}">⏺ ${esc(e.text).replace(/`([^`]+)`/g, "<b>$1</b>")}</div>`;
      })
      .join("\n")}
  </div>
  <div class="tag">Real session (${Math.round(durationMs / 1000)} s) · replayed from its log · sped up</div>
  </div>
  <script>
  const C1 = ${JSON.stringify(setupCmd)}, C2 = ${JSON.stringify(runCmd)};
  const $ = (id) => document.getElementById(id);
  const scr = $("scr");
  const follow = () => { scr.scrollTop = scr.scrollHeight; };
  function type(el, text, sec) { return new Promise((r) => { let i = 0; const step = Math.max(1, Math.round(text.length / (sec * 30)));
    const t = setInterval(() => { i = Math.min(text.length, i + step); el.textContent = text.slice(0, i); follow(); if (i >= text.length) { clearInterval(t); r(); } }, 33); }); }
  const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
  // step API (the recorder calls each step when its narration line starts)
  window.typeSetup = async () => { await type($("c1"), C1, 1.8); $("c1n").classList.remove("hidden"); $("c1m").classList.remove("hidden"); };
  window.typeRun = async () => { $("cur1").classList.add("hidden"); $("l2").classList.remove("hidden"); $("cur2").classList.remove("hidden");
    await type($("c2"), C2, 1.6); $("cur2").classList.add("hidden"); };
  window.reveal = async (sec) => { const evs = [...document.querySelectorAll("[data-ev]")]; const step = sec / evs.length;
    for (const el of evs) { await wait(step); el.classList.remove("hidden"); follow(); } window.done = true; };
  // the paid status line and Claude's final line stay highlighted while the narration explains them
  window.highlightPaid = () => { const evs = [...document.querySelectorAll("[data-ev]")]; const paid = evs.filter((e) => e.classList.contains("ok")).at(-1);
    for (const el of [paid, evs.at(-1)]) if (el) el.classList.add("hl"); follow(); };
  </script></body></html>`;
}
