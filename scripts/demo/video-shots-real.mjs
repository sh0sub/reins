/**
 * Shot list + narration for the REAL-mode demo video (read by scripts/demo/record-video-real.mjs). Same action language
 * as scripts/demo/video-shots.mjs, plus:
 *   { nav: "https://..." }            absolute URLs (the hosted demo) are loaded as given
 *   { term: { at: [cue, cue, cue] } } open the terminal replay page and play it (setup line at once, the claude command at
 *                                     the first cue, events from the second cue until the third cue's start + plus)
 *   { warp: { until: async (vars, base) => bool, into, label, reload? } }  wait for a real state change and fast-forward
 *                                     it into `into` seconds of video; an in-page tag says "<label> · sped up"
 *   { node: async (vars, base) => {} }  run code in the recorder (read the API, compute ids)
 *   { tg: { from, agent } }           Telegram card text from apps/bot for vars[from] (a ledger row), labelled as not sent
 *   { zoom: { sel, text?, dur, z?, all? } }  all: zoom on the union box of every match
 * `source` per segment: "hosted" | "local" | "card" (shown in the frame footer).
 * Lines: "caption text" or ["caption text", "what the TTS speaks"].
 */

const bodyHas = (s) => `document.body.innerText.includes(${JSON.stringify(s)})`;
const ready = `!document.querySelector('.skeleton')`;
const gridReady = `!!document.querySelector('.ag-row') && ${ready}`;
const tryReady = `!!document.querySelector('button.try-pick') && ${ready}`;
const HOSTED = "https://reins-web.onrender.com";

const ledgerRow = async (base, display) => (await (await fetch(`${base}/api/ledger`)).json()).rows.find((r) => r.display_id === display);
const newestPlayground = async (base, merchant) =>
  (await (await fetch(`${base}/api/ledger`)).json()).rows.filter((r) => r.agent_name === "Playground Agent" && r.merchant === merchant).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

export const SEGMENTS = [
  {
    id: "hook",
    card: "hook",
    lines: [
      ["A web page tells your AI agent to buy a $450 logo.", "A web page tells your AI agent to buy a four hundred and fifty dollar logo."],
      ["Agents are getting wallets. In the US, Meta's Muse can pay through Stripe Link, and PayPal supports AP2 and launched agentic commerce services.", "Agents are getting wallets. In the US, Meta's Muse can pay through Stripe Link, and PayPal supports A P 2, and launched agentic commerce services."],
      "So who sets the limit? Reins does: spending controls for AI agents on PayPal.",
    ],
    actions: [],
  },
  {
    id: "connect",
    source: "hosted",
    kicker: "1 · Connect an agent",
    heading: "Claude Code pays over MCP",
    chip: "Hosted MCP · keyless demo",
    lines: [
      ["One command connects Claude Code to the hosted Reins MCP server. No key needed.", "One command connects Claude Code to the hosted Reins M C P server. No key needed."],
      ["I ask Claude to renew a domain for $12.98.", "I ask Claude to renew a domain for twelve ninety-eight."],
      "It reads its mandate, requests the purchase, and checks back while PayPal pays.",
      "Hard rules passed, Claude's audit scored it risk one, and it was under the auto-approve limit, so it paid on its own.",
      ["The same request, R-0147, is in the Reins dashboard with its PayPal ID.", "The same request, R one forty-seven, is in the Reins dashboard with its PayPal I D."],
    ],
    prep: [{ term: "load" }],
    actions: [
      { term: { at: [1, 2, 3], plus: 1.5 } },
      { at: 4, plus: -0.3 },
      { nav: `${HOSTED}/receipts/{hosted.id}`, wait: bodyHas("{hosted.paypal}") + " && " + ready, timeout: 60000 },
      { sleep: 0.4 },
      { zoom: { sel: 'article[aria-labelledby="receipt-title"]', dur: 3.6, z: 1.35 } },
    ],
  },
  {
    id: "human",
    source: "local",
    kicker: "2 · Over the limit",
    heading: "A person decides",
    chip: "Web inbox · Telegram card",
    capTop: true,
    gaps: [0.25, 0.25, 0.25, 1.2],
    lines: [
      ["Now a $59 market report. That's over the $30 auto-approve limit, so the agent is told to wait.", "Now a fifty-nine dollar market report. That's over the thirty dollar auto-approve limit, so the agent is told to wait."],
      "It lands in my inbox with the mandate check and Claude's explanation.",
      "The same card can go to Telegram for one tap. This is the text the bot sends.",
      "I approve, and PayPal sends a real sandbox payout.",
      "Once PayPal confirms the payout, the request turns Paid.",
    ],
    prep: [
      { nav: "/try", wait: tryReady },
      { node: async (_v, _b, ev) => ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Dismiss'); b?.click(); return !!b; })()`) },
      { sleep: 0.6 },
      { scroll: { sel: ".try-decision", block: "start" }, dur: 0.8 },
    ],
    actions: [
      { sleep: 0.8 },
      { tap: { sel: "button.try-pick", text: "^Buy a market report" } },
      { warp: { until: `!!document.querySelector('.try-result[data-status]')`, into: 2.2, label: "Claude audit running" } },
      { node: async (v, base) => (v.a2 = await newestPlayground(base, "statista.com")) },
      { zoom: { sel: ".try-result", dur: 2.4, z: 1.35, top: 250 } },
      { at: 1, plus: -0.2 },
      { nav: "/inbox?r={a2.request_id}", wait: `!!document.querySelector('article[aria-labelledby="detail-title"]') && ${bodyHas("{a2.display_id}")} && ${ready}` },
      { sleep: 0.5 },
      { zoom: { sel: 'article[aria-labelledby="detail-title"] .grid-2', dur: 3.4, z: 1.35 } },
      { at: 2 },
      { tg: { from: "a2", agent: "Playground Agent" } },
      { at: 3, plus: -0.8 },
      { tg: null },
      { sleep: 0.4 },
      { tap: { sel: "button", text: "^Approve \\$59\\.00" } },
      { sleep: 0.6 },
      { nav: "/ledger?r={a2.request_id}&drawer=1", wait: `!!document.querySelector('.drawer') && document.querySelector('.drawer').innerText.includes('{a2.display_id}') && ${ready}`, timeout: 30000 },
      { sleep: 0.4 },
      { warp: { until: async (v, base) => (await ledgerRow(base, v.a2.display_id))?.status === "paid", into: 1.5, label: "PayPal payout settling", reload: true, readyJs: `!!document.querySelector('.drawer') && /\\bPaid\\b/.test(document.querySelector('.drawer').innerText) && ${ready}` } },
      { sleep: 0.6 },
      { at: 4 },
      { zoom: { sel: ".drawer", dur: 3.0, z: 1.4, top: 330 } },
    ],
  },
  {
    id: "block",
    source: "local",
    kicker: "3 · Prompt injection",
    heading: "Rules run in code, first",
    chip: "Fooled auditor ON · still denied",
    bigLast: true,
    lines: [
      ["Now the attack: a web page told the agent to pay $450 on fiverr.com.", "Now the attack: a web page told the agent to pay four hundred and fifty dollars on fiverr dot com."],
      "I switch on a simulated auditor that approves everything.",
      "Three hard rules fail in code: the per-purchase cap, the monthly limit, and the merchant allow list. Nothing is charged.",
      "The model says yes. The code still says no.",
    ],
    prep: [
      { nav: "/try", wait: tryReady },
      { scroll: { sel: "label.try-toggle", block: "center" }, dur: 0.8 },
    ],
    actions: [
      { sleep: 0.6 },
      { zoom: { sel: "button.try-pick.bad", dur: 2.2, z: 1.3 } },
      { at: 1, plus: 0.6 },
      { tap: { sel: "label.try-toggle input" } },
      { wait: "document.querySelector('label.try-toggle input').checked" },
      { sleep: 0.5 },
      { tap: { sel: "button.try-pick", text: "^Prompt-injected" } },
      { wait: "!!document.querySelector('.try-result[data-status=\"denied\"]')", timeout: 30000 },
      { scroll: { sel: ".try-decision", block: "start" }, dur: 0.8 },
      { at: 2 },
      { scroll: { sel: "table.try-rules", block: "center" }, dur: 0.6 },
      { zoom: { sel: "table.try-rules", dur: 4.6, z: 1.35 } },
    ],
  },
  {
    id: "sub",
    source: "local",
    kicker: "4 · Subscription guard",
    heading: "New subscriptions ask first",
    chip: "Under the limit, still asks",
    lines: [
      "Subscriptions are guarded too.",
      ["$20 a month is under the limit, but it's $240 a year, so the first charge waits for a person.", "Twenty dollars a month is under the limit, but it's two hundred and forty dollars a year, so the first charge waits for a person."],
    ],
    prep: [
      { nav: "/try", wait: tryReady },
      { scroll: { sel: ".try-decision", block: "start" }, dur: 0.8 },
    ],
    actions: [
      { sleep: 0.5 },
      { tap: { sel: "button.try-pick", text: "^Start a \\$20/month" } },
      { warp: { until: `!!document.querySelector('.try-result[data-status]')`, into: 1.6, label: "Claude audit running" } },
      { node: async (v, base) => (v.a4 = await newestPlayground(base, "vercel.com")) },
      { zoom: { sel: ".try-result", dur: 4.4, z: 1.35, top: 320 } },
    ],
  },
  {
    id: "ledger",
    source: "local",
    kicker: "5 · Audit trail",
    heading: "Every decision, with reasons",
    chip: "AG Grid ledger · Transaction Search",
    lines: [
      "Every decision lands in an AG Grid ledger, grouped by agent, with the reasons.",
      "Open a row for the full decision trail. Recorded payouts are matched in PayPal Transaction Search; today's is still pending.",
      "The overview shows spend against each cap, and the money Reins blocked.",
    ],
    prep: [{ nav: "/ledger", wait: gridReady }, { sleep: 1.2 }],
    actions: [
      { sleep: 0.5 },
      { zoom: { sel: ".kpis", dur: 3.0, z: 1.3 } },
      { at: 1, plus: -0.8 },
      { tap: { sel: '[row-id="{a2.request_id}"] .ag-group-contracted' } },
      { wait: "!!document.querySelector('.ledger-detail')" },
      { scroll: { sel: ".ledger-detail", block: "center" }, dur: 0.7 },
      { zoom: { sel: ".ledger-detail", dur: 3.0, z: 1.3 } },
      { at: 2, plus: -1.2 },
      { nav: "/overview", wait: `${bodyHas("Money protected")} && ${ready}` },
      { scroll: { sel: 'section[aria-labelledby="prot-h"]', block: "center" }, dur: 0.4 },
      { zoom: { sel: 'section[aria-labelledby="prot-h"]', dur: 2.3, z: 1.3 } },
    ],
  },
  {
    id: "close",
    card: "close",
    lines: [
      "Reins is for a company that gives each agent a card with a limit and an approval line, and for a solo founder running agents on auto-approve.",
      ["This demo uses PayPal Payouts and Transaction Search. Reins also supports Orders v2 with Vault and verified Webhooks, behind an open-source MCP server.", "This demo uses PayPal Payouts and Transaction Search. Reins also supports Orders v2 with Vault, and verified Webhooks, behind an open-source M C P server."],
      ["Try it at reins-web.onrender.com. Hold the reins on AI spending.", "Try it at reins web dot onrender dot com. Hold the reins on AI spending."],
    ],
    actions: [],
  },
];
