/**
 * Shot list + narration for the REAL-mode demo video (read by scripts/demo/record-video-real.mjs). Same action language
 * as scripts/demo/video-shots.mjs, plus:
 *   { nav: "https://..." }            absolute URLs (the hosted demo) are loaded as given
 *   { say: n, top? }                  narration line n starts now (after the previous line + gap); top = caption at the top
 *   { hold: n, plus? }                wait until line n has been spoken (+ plus seconds)
 *   { js: "expr" }                    evaluate in the page (terminal replay steps: typeSetup, typeRun, reveal, highlightPaid)
 * Rule: put the right page on screen first, then { say }; keep it there until { hold }.
 *   (old) { term: { at: [cue, cue, cue] } } open the terminal replay page and play it (setup line at once, the claude command at
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
      "Agents are getting wallets: in the US, Meta's Muse can pay through Stripe Link.",
      ["PayPal supports AP2 and launched agentic commerce services.", "PayPal supports A P 2, and launched agentic commerce services."],
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
      "It reads its mandate, requests the purchase, and checks the status until PayPal has paid.",
      "Hard rules passed, Claude's audit scored it risk one, and it was under the auto-approve limit, so it paid on its own.",
      ["The same request, R-0146, is in the Reins dashboard with its PayPal ID.", "The same request, R one forty-six, is in the Reins dashboard with its PayPal I D."],
    ],
    prep: [{ term: "load" }],
    actions: [
      { say: 0 },
      { js: "void window.typeSetup(), true" },
      { hold: 0 },
      { say: 1 },
      { js: "void window.typeRun(), true" },
      { hold: 1 },
      { say: 2 },
      { js: "void window.reveal(4.6), true" },
      { wait: "window.done === true", timeout: 15000 },
      { js: "window.highlightPaid(), true" },
      { sleep: 0.3 },
      { say: 3 },
      { hold: 3, plus: 0.3 },
      { nav: `${HOSTED}/receipts/{hosted.id}`, wait: bodyHas("{hosted.paypal}") + " && " + ready, timeout: 60000 },
      { say: 4 },
      { zoom: { sel: 'article[aria-labelledby="receipt-title"]', dur: 0.1, center: true, async: true } },
      { hold: 4, plus: 0.4 },
    ],
  },
  {
    id: "human",
    source: "local",
    kicker: "2 · Over the limit",
    heading: "A person decides",
    chip: "Web inbox · Telegram card",
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
      { sleep: 0.2 },
      { say: 0 },
      { tap: { sel: "button.try-pick", text: "^Buy a market report" } },
      { warp: { until: `!!document.querySelector('.try-result[data-status]')`, into: 1.8, label: "Claude audit running" } },
      { node: async (v, base) => (v.a2 = await newestPlayground(base, "statista.com")) },
      { hold: 0, plus: 0.6 },
      { nav: "/inbox?r={a2.request_id}", wait: `!!document.querySelector('article[aria-labelledby="detail-title"]') && ${bodyHas("{a2.display_id}")} && ${ready}` },
      { scroll: { sel: 'article[aria-labelledby="detail-title"] .grid-2', block: "center" }, dur: 0.3 },
      { say: 1 },
      { zoom: { sel: 'article[aria-labelledby="detail-title"] .grid-2', dur: 0.1, async: true } },
      { hold: 1, plus: 0.2 },
      { tg: { from: "a2", agent: "Playground Agent" } },
      { sleep: 0.4 },
      { say: 2 },
      { hold: 2, plus: 0.3 },
      { tg: null },
      { sleep: 0.35 },
      { say: 3, top: true },
      { tap: { sel: "button", text: "^Approve \\$59\\.00" } },
      { hold: 3, plus: 0.2 },
      { nav: "/ledger?r={a2.request_id}&drawer=1", wait: `!!document.querySelector('.drawer') && document.querySelector('.drawer').innerText.includes('{a2.display_id}') && ${ready}`, timeout: 30000 },
      { say: 4 },
      { warp: { until: async (v, base) => (await ledgerRow(base, v.a2.display_id))?.status === "paid", into: 1.4, label: "PayPal payout settling", reload: true, readyJs: `!!document.querySelector('.drawer') && /\\bPaid\\b/.test(document.querySelector('.drawer').innerText) && ${ready}` } },
      { zoom: { sel: ".drawer", dur: 0.1, async: true } },
      { hold: 4, plus: 1.0 },
    ],
  },
  {
    id: "block",
    source: "local",
    corner: "PayPal sandbox · simulated fooled auditor",
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
      { sleep: 0.2 },
      { say: 0 },
      { hold: 0, plus: 0.1 },
      { say: 1 },
      { sleep: 0.5 },
      { tap: { sel: "label.try-toggle input" } },
      { wait: "document.querySelector('label.try-toggle input').checked" },
      { sleep: 0.5 },
      { tap: { sel: "button.try-pick", text: "^Prompt-injected" } },
      { wait: "!!document.querySelector('.try-result[data-status=\"denied\"]')", timeout: 30000 },
      { hold: 1 },
      { scroll: { sel: "table.try-rules", block: "center" }, dur: 0.6 },
      { say: 2 },
      { zoom: { sel: "table.try-rules", dur: 0.1, center: true, async: true } },
      { hold: 2, plus: 0.1 },
      { say: 3 },
      { hold: 3 },
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
      { sleep: 0.2 },
      { say: 0 },
      { tap: { sel: "button.try-pick", text: "^Start a \\$20/month" } },
      { warp: { until: `!!document.querySelector('.try-result[data-status]')`, into: 1.1, label: "Claude audit running" } },
      { node: async (v, base) => (v.a4 = await newestPlayground(base, "vercel.com")) },
      { say: 1 },
      { zoom: { sel: ".try-result", dur: 0.1, async: true } },
      { hold: 1, plus: 0.6 },
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
      { sleep: 0.2 },
      { say: 0 },
      { zoom: { sel: ".kpis", dur: 0.1, async: true } },
      { hold: 0, plus: 0.2 },
      { tap: { sel: '[row-id="{a2.request_id}"] .ag-group-contracted' } },
      { wait: "!!document.querySelector('.ledger-detail')" },
      { scroll: { sel: ".ledger-detail", block: "center" }, dur: 0.5 },
      { say: 1 },
      { zoom: { sel: ".ledger-detail", dur: 0.1, center: true, async: true } },
      { hold: 1, plus: 0.2 },
      { nav: "/overview", wait: `${bodyHas("Money protected")} && ${ready}` },
      { scroll: { sel: 'section[aria-labelledby="prot-h"]', block: "center" }, dur: 0.3 },
      { say: 2 },
      { zoom: { sel: 'section[aria-labelledby="prot-h"]', dur: 0.1, center: true, async: true } },
      { hold: 2, plus: 0.8 },
    ],
  },
  {
    id: "close",
    card: "close",
    lines: [
      "For companies giving each agent a limit and an approval line, and solo founders on auto-approve.",
      "This demo uses PayPal Payouts and Transaction Search. Reins also supports Orders v2, Vault and verified Webhooks.",
      ["Try it at reins-web.onrender.com.", "Try it at reins web dot onrender dot com."],
    ],
    tempo: 1.14,
    gaps: [0.2, 0.2],
    tail: 0.9,
    actions: [],
  },
];
