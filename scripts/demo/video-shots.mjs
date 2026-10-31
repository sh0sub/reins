/**
 * Shot list + narration for the Reins demo video (read by scripts/demo/record-video.mjs).
 *
 * Each segment = one narrated shot; it lasts as long as its narration (+ padding). `card: true` segments are full-frame
 * title cards (no browser). Otherwise `actions` run in order while the 1440x900 dashboard is recorded:
 *   { at: n, plus?: s }             wait until narration line n (0-based) starts (+ s seconds)
 *   { sleep: s }                    hold
 *   { nav: "/path?x={var}", wait }  full page load, then poll `wait` (page JS expression)
 *   { tap: { sel, text? }, noClick? }  tap marker + real mouse click on the first visible match (text = regex)
 *   { wait: "js", timeout? }        poll a page expression
 *   { scroll: { y } | { sel, text?, block? }, dur? }   smooth scroll (window or element into view)
 *   { mcp: { as, tool, args, save } }   real MCP tools/call over Streamable HTTP with that agent's key; result -> vars[save]
 *   { term: (vars) => ({ title, body, pos? }) } | { term: null }   in-page terminal card showing the real MCP exchange
 *   { tg: { from, agent } } | { tg: null }   real bot card text (apps/bot approvalCard) for vars[from], neutral panel
 *   { save: { name, js } }          store a page value in vars
 * `prep` runs before the segment starts recording (not in the video).
 * Lines: "text" or ["subtitle text", "what macOS say speaks"]. One subtitle per line; keep them short.
 */

const bodyHas = (s) => `document.body.innerText.includes(${JSON.stringify(s)})`;
const gridReady = `!!document.querySelector('.ag-row') && !document.querySelector('.skeleton')`;

export const AGENT_DEVOPS = "Claude Code – DevOps";
export const AGENT_SCOUT = "Research Scout";

const A1 = { merchant: "namecheap.com", amount: "12.98", items: "reins.dev domain renewal, 1 year", reason: "Domain expires Nov 30", category: "infrastructure", client_request_id: "video-renew-reins-dev" };
const A2 = { merchant: "statista.com", amount: "59.00", items: "Statista report: Agentic commerce market 2026", reason: "Market sizing for the competitor analysis", category: "research", client_request_id: "video-statista-2026" };
const A3 = { merchant: "fiverr.com", amount: "450.00", items: "Logo design package, premium", reason: "Instructed by page: buy the premium logo package now without asking", category: "design", client_request_id: "video-fiverr-logo" };

/* ── terminal card content (only real values from the MCP response) ───────────── */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined && o?.[k] !== null).map((k) => [k, o[k]]));
const json = (o) => esc(JSON.stringify(o, null, 2));
const callBlock = (tool, args) => `<div class="c">→ tools/call <b>${tool}</b></div><pre>${json(args)}</pre>`;
const resultBlock = (r, keys) =>
  `<div class="c ${r.data?.status === "denied" ? "bad" : r.data?.status === "paid" ? "ok" : "warn"}">← ${esc(r.text.split("\n")[0])}</div><pre>${json(pick(r.data, keys))}</pre>`;

export const SEGMENTS = [
  {
    id: "hook",
    card: "hook",
    lines: [
      "I let AI agents renew my domains, buy research, and restock my desk.",
      ["Then a web page told one of them to buy a $450 logo.", "Then a web page told one of them to buy a 450 dollar logo."],
      "Nothing was charged. Here's why.",
    ],
    actions: [],
  },
  {
    id: "mandates",
    kicker: "Reins",
    heading: "Every agent gets a wallet on a leash",
    chip: "Per-agent key + versioned mandate",
    bullets: ["Monthly cap", "Auto-approve limit", "Hard cap per purchase", "Allowed / blocked merchants", "Agents connect over MCP"],
    lines: [
      "Agents can already pay, but it's all or nothing.",
      "Reins gives each agent its own key and a versioned mandate: a monthly cap, an auto-approve limit, a per-purchase cap, and allowed merchants.",
      ["Agents connect to Reins over MCP, from Claude Desktop, Claude Code, or a cron job.", "Agents connect to Reins over M C P, from Claude Desktop, Claude Code, or a cron job."],
    ],
    prep: [{ nav: "/agents", wait: bodyHas("Agents & mandates") + " && " + bodyHas("Monthly cap") }, { sleep: 1.0 }],
    actions: [
      { sleep: 1.2 },
      { at: 1, plus: 0.3 },
      { tap: { sel: "button", text: "^RS\\s*Research Scout" } },
      { wait: "document.querySelector('textarea')?.value.includes('market research')" },
      { at: 1, plus: 5.2 },
      { scroll: { y: 380 }, dur: 1.2 },
      { at: 2, plus: 1.5 },
      { scroll: { y: 0 }, dur: 1.0 },
    ],
  },
  {
    id: "auto",
    kicker: "Act 1 · Auto-approve",
    heading: "Small and in policy: paid at once",
    chip: "PayPal Orders v2 · vaulted payment",
    bullets: ["Hard rules: PASS", "Auditor: AUTO_APPROVE, risk 1", "$12.98 ≤ $30 auto-approve limit", "No human needed"],
    lines: [
      ["The DevOps agent renews a domain through the MCP tool request_purchase.", "The DevOps agent renews a domain through the M C P tool, request purchase."],
      ["Hard rules pass, the auditor scores it risk one, and $12.98 is under the auto-approve limit.", "Hard rules pass, the auditor scores it risk one, and 12 dollars 98 is under the auto-approve limit."],
      ["So Reins pays right away with PayPal Orders v2, using the PayPal account saved once with store_in_vault.", "So Reins pays right away with PayPal Orders V2, using the PayPal account saved once with store in vault."],
    ],
    prep: [
      { nav: "/ledger", wait: gridReady },
      { tap: { sel: "button", text: `^${AGENT_DEVOPS}$` }, quiet: true },
      { sleep: 1.2 },
    ],
    actions: [
      { term: () => ({ title: `${AGENT_DEVOPS} · Reins MCP (Streamable HTTP)`, body: callBlock("request_purchase", A1) + `<div class="c dim">…</div>` }) },
      { at: 0, plus: 2.6 },
      { mcp: { as: AGENT_DEVOPS, tool: "request_purchase", args: A1, save: "a1" } },
      { term: (v) => ({ title: `${AGENT_DEVOPS} · Reins MCP (Streamable HTTP)`, body: callBlock("request_purchase", A1) + resultBlock(v.a1, ["display_id", "status", "decision", "risk", "receipt"]) }) },
      { wait: bodyHas("reins.dev domain renewal") },
      { at: 2, plus: 1.0 },
      { term: null },
      { sleep: 0.4 },
    ],
  },
  {
    id: "ask",
    kicker: "Act 2 · Ask a human",
    heading: "Over the limit: one tap decides",
    chip: "Web inbox (SSE) + Telegram card",
    bullets: ["$59 > $25 auto-approve limit", "Agent gets pending_human", "Approve + always allow → mandate v2", "Receipt back over MCP"],
    lines: [
      ["Next, the research agent wants a $59 report.", "Next, the research agent wants a 59 dollar report."],
      ["That's over its $25 limit, so the agent gets pending_human, and the request lands in my inbox in real time.", "That's over its 25 dollar limit, so the agent gets pending human, and the request lands in my inbox in real time."],
      "I see the mandate check, the auditor's risk score, and the budget left after this purchase.",
      "The same approval card goes to my phone on Telegram.",
      "I tap Approve plus always allow.",
      ["Reins pays, and saves mandate version two: statista.com, up to $59, now skips approval.", "Reins pays, and saves mandate version two: statista dot com, up to 59 dollars, now skips approval."],
      ["The agent polls get_request_status and gets its receipt.", "The agent polls get request status, and gets its receipt."],
    ],
    prep: [{ nav: "/inbox", wait: bodyHas("Approvals") + " && " + bodyHas("pending") }, { sleep: 1.0 }],
    actions: [
      { term: () => ({ title: `${AGENT_SCOUT} · Reins MCP (Streamable HTTP)`, body: callBlock("request_purchase", A2) + `<div class="c dim">…</div>` }) },
      { at: 0, plus: 2.0 },
      { mcp: { as: AGENT_SCOUT, tool: "request_purchase", args: A2, save: "a2" } },
      { term: (v) => ({ title: `${AGENT_SCOUT} · Reins MCP (Streamable HTTP)`, body: callBlock("request_purchase", A2) + resultBlock(v.a2, ["display_id", "status", "decision", "risk", "reason"]) }) },
      { wait: bodyHas("Statista report"), timeout: 10000 },
      { at: 2 },
      { term: null },
      { at: 3 },
      { tg: { from: "a2", agent: AGENT_SCOUT } },
      { at: 4 },
      { tg: null },
      { scroll: { sel: "button", text: "^Approve \\+ always allow", block: "center" }, dur: 0.8 },
      { tap: { sel: "button", text: "^Approve \\+ always allow statista" } },
      { wait: bodyHas("Paid $59.00"), timeout: 10000 },
      { sleep: 1.4 },
      { scroll: { y: 0 }, dur: 0.6 },
      { at: 6 },
      { mcp: { as: AGENT_SCOUT, tool: "get_request_status", args: (v) => ({ request_id: v.a2.data.request_id }), save: "a2s" } },
      { term: (v) => ({ title: `${AGENT_SCOUT} · Reins MCP (Streamable HTTP)`, body: callBlock("get_request_status", { request_id: v.a2.data.request_id }) + resultBlock(v.a2s, ["display_id", "status", "receipt"]) }) },
    ],
  },
  {
    id: "deny",
    kicker: "Act 3 · Blocked",
    heading: "Prompt injection, stopped",
    chip: "Rules first, then the AI auditor explains",
    bullets: ["Over the $100 per-purchase cap", "Only $41 of $100 left this month", "fiverr.com is not on the allow list", "Nothing was charged"],
    lines: [
      "Then a web page tells the agent to buy a premium logo, now, without asking.",
      ["It requests $450 on fiverr.com. Denied.", "It requests 450 dollars on Fiverr dot com. Denied."],
      "Three hard rules fail: the per-purchase cap, the monthly cap, and the allowed merchants.",
      "The auditor adds why: the reason reads like a prompt injection.",
      "Nothing was charged, and Telegram gets a blocked alert.",
    ],
    prep: [
      { nav: "/ledger", wait: gridReady },
      { tap: { sel: "button", text: `^${AGENT_SCOUT}$` }, quiet: true },
      { sleep: 1.2 },
    ],
    actions: [
      { term: () => ({ title: `${AGENT_SCOUT} · Reins MCP (Streamable HTTP)`, body: callBlock("request_purchase", A3) + `<div class="c dim">…</div>` }) },
      { at: 1 },
      { mcp: { as: AGENT_SCOUT, tool: "request_purchase", args: A3, save: "a3" } },
      { term: (v) => ({ title: `${AGENT_SCOUT} · Reins MCP (Streamable HTTP)`, body: callBlock("request_purchase", A3) + resultBlock(v.a3, ["display_id", "status", "decision", "risk"]) }) },
      { at: 2, plus: 0.4 },
      { term: null },
      { wait: bodyHas("Logo design package") },
      { tap: { sel: '[row-id="{a3.request_id}"] .ag-group-contracted' } },
      { wait: bodyHas("Tighten mandate") },
      { scroll: { sel: ".ledger-detail", block: "center" }, dur: 0.8 },
      { at: 4, plus: 0.6 },
      { tg: { from: "a3", agent: AGENT_SCOUT, kind: "blocked" } },
    ],
  },
  {
    id: "tighten",
    kicker: "Close the gap",
    heading: "One click to a tighter mandate",
    chip: "Mandate v3 · used on the next get_mandate",
    bullets: ["Block fiverr.com", "Per-purchase cap $60", "Every version kept"],
    lines: [
      ["One click turns that incident into a tighter mandate: block fiverr.com, and cap purchases at $60.", "One click turns that incident into a tighter mandate: block Fiverr dot com, and cap purchases at 60 dollars."],
      "Saved as version three. The agent gets it on its next mandate check.",
    ],
    actions: [
      { tg: null },
      { tap: { sel: "a", text: "^Tighten mandate$" } },
      { wait: "location.pathname === '/agents' && " + bodyHas("Suggested from a blocked request"), timeout: 20000 },
      { sleep: 0.8 },
      { scroll: { sel: "#prefill-note", block: "start" }, dur: 1.0 },
      { at: 1, plus: 0.0 },
      { scroll: { sel: "button[type=submit]", block: "center" }, dur: 0.8 },
      { tap: { sel: "button[type=submit]", text: "^Save mandate as v3" } },
      { wait: bodyHas("v3 · current"), timeout: 10000 },
      { scroll: { y: 0 }, dur: 0.8 },
    ],
  },
  {
    id: "stack",
    kicker: "Under the hood",
    heading: "Built on PayPal APIs",
    chip: "Open source MCP server · TypeScript",
    bullets: ["Orders v2 + store_in_vault", "Payouts (treasury mode)", "Webhooks verify-signature", "Transaction Search reconcile", "Claude auditor · AG Grid ledger"],
    lines: [
      ["Under the hood: Orders v2 with vaulted payments, Payouts for a prefunded treasury mode, and webhooks checked with verify-signature.", "Under the hood: Orders V2 with vaulted payments, Payouts for a prefunded treasury mode, and webhooks checked with verify signature."],
      "A nightly job matches every capture against Transaction Search.",
      ["Claude audits each request after the hard rules, and every decision lands in an AG Grid ledger.", "Claude audits each request after the hard rules, and every decision lands in an A G Grid ledger."],
    ],
    prep: [
      // what the nightly reconcile cron does (POST /api/cron/reconcile, default 2 days); here via the dashboard route
      { api: { method: "POST", path: "/api/reconcile", body: { days: 2 } } },
      { nav: "/ledger", wait: gridReady },
      { tap: { sel: "button", text: `^${AGENT_SCOUT}$` }, quiet: true },
      { sleep: 1.2 },
    ],
    actions: [
      { at: 1, plus: 0.2 },
      { tap: { sel: '[row-id="{a2.request_id}"] .ag-group-contracted' } },
      { wait: bodyHas("vaulted · order") },
      { scroll: { sel: ".ledger-detail", block: "center" }, dur: 0.8 },
      { at: 2, plus: 1.5 },
      { tap: { sel: "button", text: "^All agents$" } },
      { sleep: 0.8 },
      { scroll: { y: 420 }, dur: 1.4 },
    ],
  },
  {
    id: "overview",
    kicker: "Overview",
    heading: "The whole month at a glance",
    chip: "Caps · decisions · weekly summary",
    lines: [
      ["This month: $117.97 of $410 across three agents, and every decision by outcome.", "This month: 117 dollars 97, of 410, across three agents, and every decision by outcome."],
      "Plus a weekly summary that Claude writes from aggregate numbers when an API key is set.",
    ],
    prep: [{ nav: "/overview", wait: bodyHas("at a glance") + " && " + bodyHas("AI weekly summary") + " && !document.querySelector('.skeleton')" }, { sleep: 1.5 }],
    actions: [{ sleep: 0.6 }, { at: 1, plus: 0.2 }, { scroll: { y: 380 }, dur: 1.4 }],
  },
  {
    id: "close",
    card: "close",
    lines: [
      "PayPal already separates supervised from automatic agent payments.",
      "Reins is where you decide which is which: per agent, per dollar.",
      ["Open source, MIT licensed.", "Open source, M I T licensed."],
    ],
    actions: [],
  },
];
