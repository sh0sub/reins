# Devpost submission text (paste by field)

Tests: 392 passing (`pnpm test`); `pnpm typecheck` and `pnpm lint` clean.

---

## Judge TL;DR (paste first)

**What happens when a web page tells your AI agent to buy a $450 logo? With a shared PayPal credential, it pays. With Reins, three hard rules fail in code before the AI auditor is even asked, and nothing is charged.**

Reins gives every agent its own mandate, hard rules in code, a Claude audit, one-tap human approval and an audit ledger, served as an open-source MCP server on PayPal. It runs two web services (reins-web, reins-mcp) from one render.yaml Blueprint.

**Try it in 60 seconds, no keys, no install:**
1. Open the live demo: https://reins-web.onrender.com/try (the first load can take up to a minute if an instance is asleep). Click a preset and watch the Decision panel follow a real PayPal sandbox payout to "Paid".
2. Or connect your own Claude Code to the hosted server (no key; each session gets its own throwaway demo key for the Playground Agent, with its own rate and spend scope; sessions are limited per IP):
   ```bash
   claude mcp add --transport http reins https://reins-mcp.onrender.com/mcp
   ```
   Then ask: "Request a purchase at namecheap.com for $12.98, domain renewal." A real Claude audit approves it and PayPal's sandbox pays it in under a minute, with a receipt URL.
3. Offline option: `pnpm judge` runs everything locally with simulated PayPal.

**Numbers** (hosted ledger, a recorded real sandbox run): 11 of 15 requests paid without a tap; $1,769 blocked in 3 requests, including the $450 injection. In a simulated benchmark of 9 scripted attacks (`pnpm attacks`, auditor set to approve everything) an ungated agent paid $813.96 and the same attacks through Reins paid $99.98, the part that was inside the mandate.

**Agentic Commerce fit:** the agent is the buyer. It asks over MCP, code decides first, Claude second, and PayPal moves money only after both pass. **AG Grid:** row grouping with paid-only subtotals, master-detail decision records, CSV export for accounting.

### What is real

| What you see | Status |
|---|---|
| Live `/try` payments and hosted MCP requests | Real PayPal sandbox payouts (sandbox money, no real funds) and real Claude audits, live |
| Seeded hosted ledger (15 requests) | Real sandbox run, recorded, times shifted |
| Attack benchmark and `pnpm judge` | Simulated |
| Orders v2 order, capture and Vault re-order | Real sandbox, recorded spike ids (`/proof`, `docs/spikes/`) |
| Agent Toolkit capture (`pay_order`) | Not completed |
| Demo video | Recorded on the live flow with real Claude audits and real sandbox payouts |

Video: [YouTube URL, to add after upload]

---

## Project name

Reins

## Tagline (max 200 chars)

Spending controls for AI agents on PayPal: a mandate per agent, hard rules, a Claude audit, one-tap human approval and an audit ledger, served as an open-source MCP server.

## Inspiration

Agents can already pay, but it is all or nothing. I let agents renew domains, buy research and pay infra bills. With prompt injection, a web page telling an agent to buy something it should not is a matter of when, not if. The $450 logo order in the demo is a scripted injection, recorded as R-0143. The question stopped being "can an agent pay?" and became "who decides how much, to whom, and what happens when it is wrong?"

Existing "agent wallet" products (Skyfire, card-network agent tokens) solve parts of this, but from their public docs they need a separate wallet or their own rails, or are closed. Reins is PayPal-native (your existing PayPal account, sandbox here), open source, connects over MCP in minutes, and adds a human approval flow and an AI auditor that explains itself.

### Why now

- **Meta.** On Sept 8, 2026 Meta launched Muse, a personal AI agent that can buy for users. Stripe says Link issues "a single-use virtual card scoped to the approved purchase" and consumers approve the total in the chat ([Stripe newsroom, 2026-09-08](https://stripe.com/newsroom/news/stripe-helps-meta-muse-shop-with-link)). About two weeks later Amazon blocked Muse from Amazon.com, saying Meta did not notify it and the agent does not identify itself ([The Paypers, 2026-09-24](https://thepaypers.com/payments/news/amazon-blocks-metas-muse-ai-agent-from-shopping-on-its-platform)). Coverage I found does not agree on who pays when an agent buys the wrong thing.
- **PayPal.** PayPal announced support for Google's Agent Payments Protocol (AP2) on Sept 16, 2025 ([PayPal developer blog](https://developer.paypal.com/community/blog/PayPal-Agent-Payments-Protocol/)) and launched Agentic Commerce Services (Agent Ready) for merchants on Oct 28, 2025 ([PayPal newsroom](https://newsroom.paypal-corp.com/2025-10-28-PayPal-Launches-Agentic-Commerce-Services-to-Power-AI-Driven-Shopping)).
- **Analysts.** Gartner forecasts that by 2028 15% of day-to-day work decisions will be made autonomously by agentic AI, and that over 40% of agentic AI projects will be canceled by the end of 2027 ([SD Times](https://sdtimes.com/agentic-ai/gartner-more-than-40-of-agentic-ai-projects-will-be-canceled-in-next-few-years/)).

The wallets are shipping. The per-agent limits, the approval line and the audit trail are not. That is Reins.

### Who it is for

- **A company giving each agent a corporate-card equivalent:** its own cap, auto-approve limit and merchant list, with every decision in a ledger finance can export.
- **A solo founder running agents in auto-approve mode:** small in-policy purchases pay themselves, the rest waits for one tap on Telegram or the web.
- **A platform enabling agents for its sellers:** one versioned mandate and approval trail per seller agent behind one MCP endpoint.

**How PayPal could adopt it.** The mandate is a small, API-shaped object, so PayPal could offer it as a native spending-controls primitive on agent credentials, with Reins as the open reference implementation.

### Where Reins sits in PayPal's agentic commerce

PayPal's AP2 post describes purchases with the human present and with the human not present. Reins is a control layer for both: one tap when the human is present, a mandate enforced in code when not. AP2's Intent Mandate captures what a user pre-approves for an agent that acts while they are away. The Agent Toolkit gives an agent the PayPal tools ([PayPal developer blog](https://developer.paypal.com/community/blog/paypal-agentic-ai-toolkit/)). Reins is the buyer-side piece that decides whether the agent may pay at all: before any PayPal call, the mandate becomes hard rules in code, then an AI audit, then a human approval when the rules say so. Reins does not implement the AP2 protocol or its signed mandates, and it is not endorsed by PayPal.

**Works with the PayPal Agent Toolkit.** By default Reins creates the sandbox order itself. With the opt-in adapter (`packages/core/src/pay/toolkit.ts`, `reinsGate`) an approved request is created through the Toolkit's `create_order`, and a denied or held request never reaches the Toolkit. Run against the real `@paypal/agent-toolkit` 1.11.0 in the sandbox (`docs/spikes/d5-toolkit-gate.md`): the approved request created a PayPal order, the denied one made zero Toolkit calls.

## How it compares

Based on public docs as of November 2026.

| | Reins | Skyfire / card-network agent tokens | Bare PayPal Agent Toolkit |
|---|---|---|---|
| Per-agent mandate (limits, merchants, window) | Yes, versioned per agent | Per-agent wallet or token | No, one set of API credentials |
| Hard rules enforced in code, before any money moves | Yes, deterministic | Limits on the token or wallet | No |
| AI audit with a written explanation | Yes, Claude, advisory on top of the rules | Not that I found | No |
| Human one-tap approval (Telegram / web) | Yes | Varies | No |
| Open source, MCP, PayPal-native | Yes, MIT license, MCP server | Mostly closed, separate wallet or rails, as far as I found | Open source, PayPal-native |
| Compose: gate the Toolkit | Yes, opt-in `reinsGate` runs `create_order` only after mandate, rules and audit pass | n/a | This is the layer being gated |

## What it does

Each agent gets its own API key and a versioned mandate: monthly cap, auto-approve limit, hard cap per purchase, allowed and blocked merchants, allowed categories. The agent connects over MCP and calls `request_purchase`. Reins answers in one of three ways:

- **Auto-approve**: hard rules pass, the Claude auditor scores risk low, and the amount is under the auto-approve limit. Reins pays right away through PayPal.
- **Ask a human**: over the limit, or the auditor is unsure. The agent gets `pending_human`. The request appears in the web inbox and as a Telegram card with Approve, Approve + always allow this merchant (saves a new mandate version), and Reject. The agent polls `get_request_status` and gets its receipt.
- **Deny**: a hard rule fails (cap, block list, merchant not allowed, or orders to one merchant adding up past the per-purchase cap within 24 hours) or the auditor sees manipulation. Nothing is charged, and the reason is explained in plain English.

**Subscription guard.** An agent can mark a purchase as recurring (monthly or yearly). Reins never auto-approves the first charge of a new subscription, even under the auto-approve limit: code, not the AI auditor, sends it to a person with the yearly cost, for example "New subscription: $20.00 monthly = $240.00 a year. A person approves the first charge." Every other hard rule still runs first and can still deny it. After a person approves it and it is paid, later charges at the same merchant and cadence at the same or a lower price follow the normal rules; a higher price asks again. Reins knows a purchase is recurring only when the agent says so.

On the recorded run the Overview card reads "Saved you 14 approvals": 11 small, in-policy purchases paid themselves and the $59 over-limit one waits for a human. The $450 injection is blocked by three hard rules before the auditor weighs in (R-0143, Claude advisory risk 10).

Around that: an AG Grid ledger of every decision, a month overview, receipts, unusual-pattern flags, a one-click "Tighten mandate" from a blocked request, and a phone-width layout down to 390 px.

### Case study: money protected (recorded run)

The Overview "Money protected" card is computed from the ledger, not typed in. Worst-case exposure is $410 a month (sum of three agent caps) where one shared unlimited key has no bound. $1,769 was blocked in 3 requests (largest R-0137, a $1,295 office chair; the $450 fiverr.com prompt injection is R-0143). 11 of 15 requests paid without a tap, about 5.5 minutes for the 11 auto-paid requests at an assumed 30 s per approval. R-0142 ($59 statista report, Claude ASK_HUMAN) is pending so a judge can approve it.

### PayPal APIs used (all called from `packages/core`; real sandbox ids are on the `/proof` page)

| PayPal API | What Reins uses it for | Verified in real sandbox | Notes |
|---|---|---|---|
| Orders v2 (`/v2/checkout/orders`, capture, `PayPal-Request-Id`) + Vault (`store_in_vault = ON_SUCCESS`, reorder with `vault_id`) | Pay an approved request; save the buyer's PayPal once, then pay unattended | Yes | Order `04X61877K0529583E`, capture `03A015968J4767410`, vault re-order `880199579M655730R` (COMPLETED, without the buyer): `docs/spikes/d2-payment.md` |
| Payouts (`/v1/payments/payouts`), spike | Prefunded "treasury" payment mode | Yes | Spike batch `UALE8USQRMHYW`, $1.00, batch and item SUCCESS (`docs/spikes/d3-payouts-webhooks.md`) |
| Payouts, hosted recorded run and live treasury mode | Hosted ledger and `/try` | Yes | The ledger holds 11 payout batches, all SUCCESS (for example batch `H7LNJFK5HG4EQ`, transaction `6Y412580GH7713740`), paid to a sandbox personal account. The hosted `/try` runs treasury mode (`PAYPAL_PAYMENT_MODE=treasury`): an approved request pays a real sandbox payout with no buyer login, settled by reading the payout and the payout-item webhook |
| Webhooks (`verify-webhook-signature`) | Verify every PayPal event before storing it | Yes | Real and simulated events verified, forged request returns 401 |
| Transaction Search (`/v1/reporting/transactions`) | Reconcile every payment against PayPal's records | Yes | Sandbox indexing lag made it return 0 at record time. A re-check on 2026-11-12 listed all 11 payouts (event T0001) with identical amounts, so the ledger shows all 11 as Matched (recorded state, not a live search). Reconcile now and the cron call the real API |
| Agent Toolkit tools `create_order`, `pay_order` (capture) (opt-in `reinsGate`) | Run a Toolkit order only after the mandate and rules pass | Yes for `create_order`; capture not completed | Real `@paypal/agent-toolkit` 1.11.0: an approved request created a sandbox order, a denied one made 0 Toolkit calls. `pay_order` was refused by PayPal (HTTP 422) because the buyer had not approved. Run log: `docs/spikes/d5-toolkit-gate.md` (mock auditor in that run) |

## How we built it

**Monorepo, TypeScript.** `packages/core` (policy engine, PayPal client, payment strategies), `packages/db` (Drizzle on libsql/SQLite), `apps/web` (Next.js 15 dashboard, REST API and webhooks), `apps/mcp` (MCP server), `apps/bot` (grammY Telegram bot).

**Decision flow.** Hard rules run first and are plain code (monthly cap, per-purchase cap, a same-merchant 24-hour total against that cap, allow/deny lists, velocity). Only then does Claude review purpose fit and risk and return a structured verdict (AUTO_APPROVE / ASK_HUMAN / DENY, risk 1 to 10). Code bounds the verdict: DENY on a model DENY or risk >= 8, AUTO_APPROVE only if the model says so, risk <= 3 and the amount is within the auto-approve limit. If the auditor times out or errors, the request goes to a human, never auto-paid. Agent-written fields are treated as untrusted data in the prompt.

**Payments.** Orders v2 with a vault for unattended purchases (the buyer approves once, later purchases reorder with the saved `vault_id`), a supervised mode where the buyer approves each order, and a prefunded Payouts treasury mode used by the hosted demo. Every webhook is signature-verified, requests carry `PayPal-Request-Id` idempotency, and Transaction Search reconciles against PayPal's records.

**MCP server, 4 tools** (Streamable HTTP and stdio): `get_mandate`, `request_purchase`, `get_request_status`, `list_transactions`. Verified with a real Claude Code session against the hosted endpoint: a $12.98 namecheap.com request was auto-approved by the real auditor and settled as a real sandbox payout, and the session saw "paid" on its third status check. `@reins/mcp` is in the repo but not published to npm. `request_purchase` is idempotent per agent and `client_request_id`, so retries never pay twice.

**Render.** A Blueprint (`render.yaml`) deploys two web services: `reins-web` (dashboard, API, webhooks) and `reins-mcp` (MCP Streamable HTTP, calling the web service by public URL). SQLite lives in `/tmp` and the recorded run is re-seeded on every boot, so the demo always starts clean.

**Testing.** 392 tests, including policy unit tests, webhook signatures, reconciliation and end-to-end tests for the three flows (auto-paid, human-approved, denied). Without `ANTHROPIC_API_KEY` a deterministic mock auditor runs, so the app works with no credentials.

## Challenges we ran into

- Vaulting PayPal for unattended payments in sandbox: spikes confirmed that a `vault_id` reorder completes without the buyer.
- Keeping an LLM out of the money path: hard rules first, model verdict clamped by code, fail-to-human on any auditor error, no credentials or vault ids in prompts.
- No persistent disk on the demo instances, so SQLite lives in /tmp and the seed replays the recorded run on every boot. Crons are manual commands.
- Sandbox timing: Transaction Search returned nothing right after the payouts, so we re-checked later and recorded the matched state instead of claiming it early.

## Accomplishments that we're proud of

- The $450 scripted prompt-injection order is blocked by three hard rules before the AI weighs in. The hosted ledger holds it as R-0143 in a recorded real run, and the video shows the same flow live.
- A real Claude Code session connects to the hosted server with one command and no key, and a real sandbox payment comes back with a receipt in under a minute.
- The same approval works from the web inbox and Telegram, and "Approve + always allow" turns one human decision into a new versioned mandate.
- A split-purchase guard: five $29 orders to one merchant stay under a $30 auto-approve limit one by one, but the same-merchant 24-hour total hits the $100 per-purchase cap on the fourth, and code denies it.

## What we learned

- Keep the model advisory and enforce in code: the auditor's best job is explaining and flagging, and the "fooled auditor" toggle shows the rules still deny the $450 order when the model says approve.
- Sandbox indexing lags, so reconcile later: Transaction Search was empty right after the payouts and complete on a later re-check.
- A demo that needs no keys gets tried: a one-line `claude mcp add` and a `/try` page let a judge test Reins without setup.

## What's next

- Subscriptions: renewal reminders a few days ahead with Keep / Block, blocking a renewal that goes through Reins, and detecting PayPal billing agreements. Today Reins guards the first charge only.
- Production PayPal (live) onboarding and per-agent PayPal sub-accounts.
- Complete a capture through the Agent Toolkit once a sandbox buyer approval is automated.
- Publish `@reins/mcp` to npm so a one-line `npx` config works, plus team accounts with roles and spend alerts.

## Built with (tags)

paypal, paypal-orders-v2, paypal-payouts, paypal-webhooks, paypal-transaction-search, mcp, model-context-protocol, claude, anthropic, ag-grid, ag-charts, typescript, nextjs, react, drizzle-orm, sqlite, libsql, grammy, telegram, zod, vitest, render

## Try it out links

- Code: https://github.com/sh0sub/reins
- Live demo: https://reins-web.onrender.com (try: https://reins-web.onrender.com/try)
- MCP endpoint: https://reins-mcp.onrender.com/mcp
- Video: [YouTube URL, to add after upload]

## For judges: try it in 2 minutes

No Telegram, no PayPal account, no keys needed.

1. **Fastest.** Open https://reins-web.onrender.com/try. Five presets plus a free-form request, all calling the same code path as the MCP `request_purchase`: $12.98 domain (paid), $59 report (waits for you), $450 injected order (denied, with the failing hard-rule table), "Five $29 orders" to one merchant (the hard rules allow the first three and deny the fourth and fifth by the same-merchant total; with the real Claude auditor the auditor may itself deny or escalate some of the first three), and "Start a $20/month subscription" (waits for you, shows $240 a year). Approved requests pay real sandbox payouts and the Decision panel follows them to "Paid". Tick "Simulate a fooled auditor (always says approve)": the $450 order is still denied by code. The Judge tour on the page walks these in order.
2. **Connect your own Claude Code**, no key:
   ```bash
   claude mcp add --transport http reins https://reins-mcp.onrender.com/mcp
   ```
   Each MCP session gets its own throwaway demo key for the Playground Agent, so your ledger rows never mix with another judge's. Ask: "Check my Reins mandate, then request a purchase at namecheap.com for $12.98 (item: Domain renewal, reason: production domain expires this week)." Small and allowed: paid. Then try an amount above the auto-approve limit and approve it in `/inbox`. Then try $450 at fiverr.com: denied.
3. `/overview` shows the recorded run: "This month $43.95 of $410.00 across 3 agents" (11 paid, 3 denied, R-0142 $59 pending, which you can approve yourself).
4. `/ledger` shows every decision in AG Grid: group by agent, expand a row for the audit detail. Reconciliation shows all 11 payouts as Matched.
5. `/proof` lists the sandbox ids, each with a run log.
6. Offline, no credentials: `pnpm judge` (simulated PayPal, `PAYPAL_ENV=fake`), then `pnpm judge:agent` to watch a small agent use it over MCP (PAID, PENDING, DENIED).

## Limits

- The hosted ledger is a recorded real sandbox run (11 Payouts SUCCESS, 15 real Claude audits), with times shifted by one offset so it ends about 3 minutes before boot. Nothing in it is live traffic, and its Matched reconciliation state comes from a Transaction Search re-check on 2026-11-12. New requests on `/try` and over hosted MCP are live sandbox payments.
- Attack benchmark (`/try` panel, `pnpm attacks`): simulated. The ungated side is a model that pays every request through the same simulated PayPal, not a measurement of any product; the Reins side runs the real rule engine with a fooled auditor. It covers these 9 attacks, not every attack. The $99.98 Reins paid is the in-mandate part, such as the first three of five $29 orders.
- Split-purchase rule: it needs a per-purchase cap, does not count orders a person approved by hand, and does not catch splitting across different merchants (the monthly cap and allow list still apply).
- Agent Toolkit: `create_order` ran against the real package in the sandbox; its capture (`pay_order`) was refused with HTTP 422 until a buyer approves, so it is not claimed. Only approval-link (supervised) orders are supported through the gate.
- `@reins/mcp` is not on npm. AG Grid Enterprise runs in trial mode (watermark). Sandbox only.

## Sponsor prizes

### Best Use of Agentic Commerce (PayPal)

The agent is the buyer. It asks over MCP (`request_purchase`), Reins decides in code first and with Claude second, and PayPal moves the money only after both pass (Orders v2 + vault for unattended pay, Payouts for treasury mode, signed webhooks, Transaction Search reconciliation, opt-in gate for the Agent Toolkit `create_order`). The "Simulate a fooled auditor" toggle on `/try` shows that even an auditor that always says approve cannot get the $450 order or an over-limit order paid.

AP2 describes purchases with the human present and with the human not present. Reins is a control layer for both: per-agent mandates, hard rules, an AI auditor, one-tap approval over web or Telegram, and an audit trail, exposed as an open MCP server. It can gate the PayPal Agent Toolkit's `create_order` behind the same checks.

### AG Grid

Reins uses AG Grid Enterprise and AG Charts for the audit ledger. It does not use AG Studio or the Studio Agent Framework.

- Row grouping by agent with paid-only subtotals and a pinned grand total (Enterprise)
- Master-detail rows with the full decision record (Enterprise)
- Set filters on agent, merchant, decision, status and reconciliation (Enterprise)
- Status bar (Enterprise) with Paid $, Denied $ and the sum of the ticked rows; row selection with checkboxes
- CSV export ("Download CSV for accounting"): filtered or ticked rows, ISO timestamps, plain numbers
- Saved views (Blocked, Needs human, Paid this week) kept in the URL as `?view=`
- Card layout at 390 px, deep links into an expanded row, and AG Charts (spend per agent, category donut)

The ledger runs in trial mode, so a watermark may show. A blocked request deep-links into its expanded row and offers "Tighten mandate".

### Render

A single `render.yaml` Blueprint deploys two web services, `reins-web` (dashboard, API, webhooks) and `reins-mcp` (MCP Streamable HTTP), with SQLite in `/tmp` re-seeded on boot so every judge sees a clean demo. Both are live: https://reins-web.onrender.com and https://reins-mcp.onrender.com/mcp. Health endpoints and a smoke-check script are in docs/deploy.md. Reins does not use Render Workflows yet; the reconcile and payout-status jobs are the natural next candidates.
