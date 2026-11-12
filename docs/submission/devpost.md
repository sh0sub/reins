# Devpost submission text (paste by field)

Tests: 392 tests passing (`pnpm test`), `pnpm lint` and `pnpm typecheck` clean.

---

## Judge TL;DR (paste first)

**AI agents are getting wallets, and nothing sits between the agent and the money. A web page told my agent to buy a $450 logo. A shared PayPal credential would have paid it. Reins blocked it in code, before any money moved.**

Reins gives every agent its own mandate, hard rules in code, a Claude audit, one-tap human approval and an audit ledger, served as an open-source MCP server on PayPal.

**Try it in 60 seconds, no keys, no install:**
1. Open the live demo: https://reins-web.onrender.com/try (first load can take up to a minute). Click a preset and watch the Decision panel follow a real PayPal sandbox payout to "Paid".
2. Or connect your own Claude Code to the hosted server (no key; each session gets its own throwaway demo agent):
   ```bash
   claude mcp add --transport http reins https://reins-mcp.onrender.com/mcp
   ```
   Then ask: "Request a purchase at namecheap.com for $12.98, domain renewal." A real Claude audit approves it and PayPal's sandbox pays it in about 20 seconds, with a receipt URL.
3. Offline option: `pnpm judge` runs everything locally with simulated PayPal.

**Numbers** (from the hosted ledger, a recorded real sandbox run): 11 of 15 requests paid without a tap, a $450 prompt injection blocked, 7 minutes saved (14 approvals at an assumed 30 s each). In a simulated benchmark of 9 scripted attacks (`pnpm attacks`, auditor set to approve everything) an ungated agent paid $813.96 and the same attacks through Reins paid $99.98, the part that was inside the mandate.

**Agentic Commerce fit:** the agent is the buyer. It asks over MCP, code decides first, Claude second, and PayPal moves money only after both pass. **AG Grid features used:** row grouping with paid-only subtotals, master-detail, Set filters, a status bar with money totals and selected-row sum, row selection, CSV export for accounting, saved views, and AG Charts (details under Sponsor prizes).

### What is real

| What you see | Status |
|---|---|
| Live `/try` payments and hosted MCP requests | Real PayPal sandbox payouts and real Claude audits, live |
| Seeded hosted ledger (15 requests) | Real sandbox run, recorded, times shifted |
| Attack benchmark and `pnpm judge` | Simulated |
| Orders v2 order, capture and Vault re-order | Real sandbox, recorded spike ids (`/proof`, `docs/spikes/`) |
| Agent Toolkit capture (`pay_order`) | Not completed |

The demo video is recorded on the live hosted flow: real Claude audits, real sandbox payouts, a real Claude Code session. Video: [YouTube URL, to add after upload]

---

## Project name

Reins

## Tagline (max 200 chars)

Spending controls for AI agents on PayPal: a mandate per agent, hard rules, a Claude audit, one-tap human approval and an audit ledger, served as an open-source MCP server.

(172 characters.)

## Inspiration

Agents can already pay, but it is all or nothing. I let agents renew my domains, buy research and pay infra bills, and then a web page told one of them to buy a $450 logo. The question stopped being "can an agent pay?" and became "who decides how much, to whom, and what happens when it is wrong?"

PayPal's own agentic-commerce docs split agent payments into supervised and automatic, yet nothing tells you which agent gets which. Existing "agent wallet" products (Skyfire, card-network agent tokens) solve parts of this, but they need a separate wallet or crypto rails, or are closed. Reins is PayPal-native (your existing PayPal account, sandbox here), open-source, connects over MCP in minutes, and puts a human approval UX and an AI auditor that explains itself on top.

### Why now

Agents are getting wallets, fast.

- **Meta.** On Sept 8, 2026 Meta launched Muse, a personal AI agent that can buy for users. Stripe says US consumers can connect Link accounts to Muse; at Link merchants it checks out with the saved payment method, elsewhere Link issues "a single-use virtual card scoped to the approved purchase", and consumers approve the transaction total in the chat ([Stripe newsroom, 2026-09-08](https://stripe.com/newsroom/news/stripe-helps-meta-muse-shop-with-link)). About two weeks later Amazon blocked Muse from Amazon.com, saying Meta did not notify it and the agent does not identify itself ([The Paypers, 2026-09-24](https://thepaypers.com/payments/news/amazon-blocks-metas-muse-ai-agent-from-shopping-on-its-platform)). That report names no liability finding, and coverage I found does not agree on who pays when an agent buys the wrong thing.
- **PayPal.** PayPal announced support for Google's Agent Payments Protocol (AP2) on Sept 16, 2025 ([PayPal developer blog](https://developer.paypal.com/community/blog/PayPal-Agent-Payments-Protocol/)) and launched Agentic Commerce Services (Agent Ready) for merchants on Oct 28, 2025 ([PayPal newsroom](https://newsroom.paypal-corp.com/2025-10-28-PayPal-Launches-Agentic-Commerce-Services-to-Power-AI-Driven-Shopping)).
- **Analysts.** Gartner predicts that by 2028 15% of day-to-day work decisions will be made autonomously by agentic AI, and that over 40% of agentic AI projects will be canceled by the end of 2027 ([SD Times](https://sdtimes.com/agentic-ai/gartner-more-than-40-of-agentic-ai-projects-will-be-canceled-in-next-few-years/)). These are forecasts, not Reins measurements.

The wallets are shipping. The per-agent limits, the approval line and the audit trail are not. That is Reins.

### Who it is for

- **A company giving each agent the equivalent of a corporate card.** A purchasing, SaaS-renewal or infra agent gets its own monthly cap, auto-approve limit and allowed-merchant list. Anything over the limit waits in an inbox for an approver, and every decision, denials included, lands in an audit ledger that finance can filter, group and export to CSV.
- **A solo founder running agents in auto-approve mode.** Small, in-policy purchases pay themselves. Everything else waits for one tap on Telegram or the web. A domain-renewal bot, a research agent and an infra-bill agent each get their own key and cap instead of sharing one card.
- **A platform enabling agents for its sellers.** Each seller's agent gets its own versioned mandate and approval trail behind one MCP endpoint.

**How PayPal could adopt it.** The mandate (cap, auto-approve limit, allowed merchants, versioned) is a small, API-shaped object, so PayPal could offer it as a native spending-controls primitive on agent credentials, with Reins as the open reference implementation.

### Where Reins sits in PayPal's agentic commerce

AP2's Intent Mandate captures what a user pre-approves for an agent that acts while they are away. Agentic Commerce Services help merchants get discovered and accept payments on AI surfaces, which is the seller side. The Agent Toolkit and MCP servers give an agent the PayPal tools ([PayPal developer blog](https://developer.paypal.com/community/blog/paypal-agentic-ai-toolkit/)). Reins is the buyer-side piece that decides whether the agent may pay at all: before any PayPal call, the mandate becomes deterministic hard rules in code, then an AI audit, then a human approval when the rules say so. Reins does not implement the AP2 protocol or its signed mandates; it uses the same idea and enforces it at the moment of payment.

**Works with the PayPal Agent Toolkit.** By default Reins creates the sandbox order itself. With the opt-in adapter (`packages/core/src/pay/toolkit.ts`, example in the README, `reinsGate`) an approved request is created through the Toolkit's `create_order`, and a denied or held request never reaches the Toolkit. Run against the real `@paypal/agent-toolkit` 1.11.0 in the sandbox (`docs/spikes/d5-toolkit-gate.md`): the approved request created a PayPal order, the denied one made zero Toolkit calls. Only approval-link (supervised) orders are supported.

## How it compares

| | Reins | Skyfire / card-network agent tokens | Bare PayPal Agent Toolkit |
|---|---|---|---|
| Per-agent mandate (limits, merchants, window) | Yes, versioned per agent | Per-agent wallet or token | No, one set of API credentials |
| Hard rules enforced in code, before any money moves | Yes, deterministic | Limits on the token or wallet | No |
| AI audit with a written explanation | Yes, Claude, advisory on top of the rules | No | No |
| Human one-tap approval (Telegram / web) | Yes | Varies | No |
| Open source, MCP, PayPal-native | Yes, MIT license, MCP server | Mostly closed, separate wallet or rails | Open source, PayPal-native |
| Compose: gate the Toolkit | Yes, opt-in `reinsGate` runs `create_order` only after mandate, rules and audit pass | n/a | This is the layer being gated |

## What it does

Each agent gets its own API key and a versioned mandate: monthly cap, auto-approve limit, hard cap per purchase, allowed and blocked merchants, allowed categories. The agent connects over MCP and calls `request_purchase`. Reins answers in one of three ways:

- **Auto-approve**: hard rules pass, the Claude auditor scores risk low, and the amount is under the auto-approve limit. Reins pays right away through PayPal.
- **Ask a human**: over the limit, or the auditor is unsure. The agent gets `pending_human`. The request appears in the web inbox in real time and as a Telegram card with Approve, Approve + always allow this merchant (saves a new mandate version), and Reject. The agent polls `get_request_status` and gets its receipt.
- **Deny**: a hard rule fails (cap, block list, merchant not allowed, or orders to one merchant adding up past the per-purchase cap within 24 hours) or the auditor sees manipulation. Nothing is charged, and the reason is explained in plain English (a Korean version is stored and shown for a Korean locale).

**Subscription guard.** An agent can mark a purchase as recurring (monthly or yearly) through the MCP tool. Reins never auto-approves the first charge of a new subscription, even under the auto-approve limit: code, not the AI auditor, sends it to a person with the yearly cost, for example "New subscription: $20.00 monthly = $240.00 a year. A person approves the first charge." Every other hard rule still runs first and can still deny it, and caps compare the actual charge. After a person approves it and it is paid, later charges at the same merchant, cadence and price follow the normal rules; a higher price asks again. The inbox, Telegram card, ledger and receipt mark it as a subscription. Reins knows a purchase is recurring only when the agent says so. Try it on `/try`: "Start a $20/month subscription".

On the recorded run the Overview card reads "Saved you 14 approvals": 11 small, in-policy purchases paid themselves and the $59 over-limit one waits for a human. The $450 injection is blocked by three hard rules before the auditor weighs in (R-0143, Claude advisory risk 10).

Around that: an AG Grid ledger of every decision with grouping and drill-down, a month overview (spend vs caps, decision mix, category donut, weekly summary), receipts, unusual-pattern flags (4th request to one merchant in 24 h, quiet hours, category outside the mandate), a one-click "Tighten mandate" from a blocked request, and a demo DevOps cron agent that pays infra bills through the same MCP server.

The dashboard is built to be driven fast: a sidebar agents list with live cap use (paused agents are marked), a Cmd/Ctrl+K palette that jumps to any page, agent or request, a request drawer with the decision timeline, a hard-rule table (which rules failed and by how much), the auditor's risk and reason, and the raw MCP request with the key redacted, plus pause/resume and key regeneration per agent, a mandate version dropdown (every version kept, open an old one to restore it), approval cards that show the mandate check and the budget left after approving, shareable deep links (`/ledger/R-0143`, `/approvals/R-0143`, `/agents/research-scout`) and a phone-width layout down to 390 px (the AG Grid ledger turns into one card per request there).

### Case study: money protected (recorded run)

The Overview "Money protected" card is computed from the ledger, not typed in. On the seed: worst-case exposure is $410 a month (sum of three agent caps) where one shared unlimited key has no bound; $1,769 blocked in 3 requests (largest R-0137, a $1,295 office chair; the $450 fiverr.com prompt injection is R-0143); 11 of 15 requests paid without a tap; (11 auto + 3 blocked) = 14 approvals x 30 s = 7 minutes saved, where 30 s per approval is an assumption, not a measurement. Nobody approved anything in it; R-0142 ($59 statista report, Claude ASK_HUMAN) is pending so a judge can approve it.

### PayPal APIs used (all called from `packages/core`; the real sandbox ids behind them are listed on the `/proof` page)

| PayPal API | What Reins uses it for | Verified in real sandbox | Notes |
|---|---|---|---|
| Orders v2 (`/v2/checkout/orders`, capture, `PayPal-Request-Id`) + Vault (`store_in_vault = ON_SUCCESS`, reorder with `vault_id`) | Pay an approved request; save the buyer's PayPal once, then pay unattended | Yes | Order `04X61877K0529583E`, capture `03A015968J4767410`, vault re-order `880199579M655730R` (COMPLETED, without the buyer): `docs/spikes/d2-payment.md` |
| Payouts (`/v1/payments/payouts`) | Prefunded "treasury" payment mode | Yes | Spike batch `UALE8USQRMHYW`, $1.00, batch and item SUCCESS (`docs/spikes/d3-payouts-webhooks.md`). The hosted ledger is a recorded real run: 11 payout batches, all SUCCESS (for example batch `H7LNJFK5HG4EQ`, transaction `6Y412580GH7713740`), paid to a sandbox personal account. The hosted `/try` runs treasury mode (`PAYPAL_PAYMENT_MODE=treasury`): an approved request pays a real sandbox payout with no buyer login, settled by reading the payout and the payout-item webhook |
| Webhooks (`verify-webhook-signature`) | Verify every PayPal event before storing it | Yes | Real and simulated events verified, forged request returns 401 |
| Transaction Search (`/v1/reporting/transactions`) | Reconcile every payment against PayPal's records | Yes | Sandbox indexing lag made it return 0 at record time. A re-check on 2026-11-12 listed all 11 payouts (event T0001) with identical amounts, so the ledger shows all 11 as Matched (recorded state, not a live search). Reconcile now and the cron call the real API |
| Agent Toolkit tools `create_order`, `pay_order` (capture) (opt-in `reinsGate`) | Run a Toolkit order only after the mandate and rules pass | Yes for `create_order`; capture not completed | Real `@paypal/agent-toolkit` 1.11.0: an approved request created a sandbox order through the Toolkit, a denied one made 0 Toolkit calls. `pay_order` was refused by PayPal (HTTP 422) because the buyer had not approved. Run log and the four fixes it forced: `docs/spikes/d5-toolkit-gate.md` (mock auditor in that run) |

## How we built it

**Monorepo, TypeScript.** `packages/core` (policy engine, PayPal client, payment strategies), `packages/db` (Drizzle on libsql/SQLite), `apps/web` (Next.js 15 dashboard, REST API and webhooks), `apps/mcp` (MCP server), `apps/bot` (grammY Telegram bot).

**Decision flow.** Hard rules run first and are plain code (monthly cap, per-purchase cap, a same-merchant 24-hour total against that cap, allow/deny lists, velocity). Only then does Claude review purpose fit and risk and return a structured verdict (AUTO_APPROVE / ASK_HUMAN / DENY, risk 1 to 10). Code bounds the verdict: DENY on a model DENY or risk >= 8, AUTO_APPROVE only if the model says so, risk <= 3 and the amount is within the auto-approve limit. If the auditor times out or errors, the request goes to a human, never auto-paid. Agent-written fields are treated as untrusted data in the prompt.

**PayPal APIs (sandbox), exact endpoints used in `packages/core`:**
- `POST /v1/oauth2/token` for client-credentials tokens
- `POST /v2/checkout/orders` (Orders v2) with `PayPal-Request-Id` idempotency, and `POST /v2/checkout/orders/{id}/capture`; `GET /v2/checkout/orders/{id}`
- Orders v2 with `payment_source.paypal.attributes.vault.store_in_vault = ON_SUCCESS` for the one-time onboarding order that saves the buyer's PayPal; later purchases reorder with the saved `vault_id` and settle without the buyer present (automatic mode). A supervised mode (buyer approves each order) is also implemented.
- `POST /v1/payments/payouts` (Payouts) for a prefunded "treasury" payment mode, and `GET /v1/payments/payouts/{id}` to settle a payout (SUCCESS paid; FAILED, DENIED, BLOCKED, RETURNED, REFUNDED, REVERSED failed; UNCLAIMED stays committed and shows "Payout unclaimed")
- `POST /v1/notifications/verify-webhook-signature` and a `/api/webhooks/paypal` endpoint that verifies every webhook (10 subscribed event types: order approved, capture completed/denied/declined, payout item succeeded/failed/blocked/returned/denied/unclaimed)
- `GET /v1/reporting/transactions` (Transaction Search) for reconciliation against PayPal's records

**MCP server, 4 tools** (Streamable HTTP and stdio): `get_mandate`, `request_purchase`, `get_request_status`, `list_transactions`. Works from Claude Desktop, Claude Code or any MCP client. Verified with a real Claude Code session against the hosted endpoint: Claude saw the four tools, and a $12.98 namecheap.com request was auto-approved by the real auditor and settled as a real sandbox payout in about 20 s. The package `@reins/mcp` is in the repo but not published to npm. `request_purchase` is idempotent per agent and `client_request_id`, so retries never pay twice.

**Claude.** Claude (Anthropic SDK structured outputs) is used for: purchase audit, category suggestions for a mandate, the weekly spend summary, and the rejection reason, plus a summary of long agent answers on the Telegram card. Without `ANTHROPIC_API_KEY` a deterministic mock auditor runs, so the whole app works with no credentials.

**AG Grid.** The ledger uses AG Grid Enterprise row grouping (toggle "group by agent" with paid-only subtotals) and master-detail (expand a row for the mandate check, auditor verdict and reason, budget left, PayPal order and capture, receipt link), with Set filters, a PayPal ID column and a reconciliation status column. AG Charts draws paid spend per agent on the ledger and the category donut on the overview.

**Render.** A Blueprint (`render.yaml`) deploys two free web services: `reins-web` (dashboard, API, webhooks) and `reins-mcp` (MCP Streamable HTTP, calling the web service by public URL). SQLite lives in `/tmp` and demo data (the recorded run) is re-seeded on every boot, so the demo always starts clean (free instances sleep after about 15 minutes and reset).

**Testing.** 392 tests passing: policy unit tests (including the split-purchase rule), MCP stdio test, Telegram bot handlers, webhook signature handling, reconciliation, and end-to-end integration tests for the three flows (auto-paid, human-approved, denied), merchant rules, receipts, anomalies, the DevOps agent and the AI summary.

## Challenges we ran into

- Vaulting PayPal for unattended payments in sandbox: we ran spikes to confirm that a `vault_id` reorder completes without the buyer, and documented the exact response shape.
- Keeping an LLM out of the money path: hard rules in code first, model verdict clamped by code, fail-to-human on any auditor error, no credentials or vault ids in prompts.
- Prompt injection from the agent's own input: the auditor treats the request fields as data, and the rules block it even if the model is fooled.
- Free-tier hosting: no disk and no cron on Render's free plan, so we chose SQLite in `/tmp` with a boot-time seed and made crons manual commands.
- Sandbox timing: Transaction Search returned nothing right after the payouts, so we re-checked later and recorded the matched state instead of claiming it early.
- One person, 18 days: we cut anything that did not show up in the 3-minute demo.

## Accomplishments that we're proud of

- The $450 prompt-injection purchase is blocked by three independent hard rules before the AI even weighs in. The hosted ledger holds it as R-0143 in a recorded real run, and the video shows the same flow live.
- A real Claude Code session connects to the hosted server with one command and no key, and a real sandbox payment comes back with a receipt in about 20 seconds.
- The same approval works from the web inbox and Telegram, and "Approve + always allow" turns one human decision into a new versioned mandate.
- A split-purchase guard: five $29 orders to one merchant stay under a $30 auto-approve limit one by one, but the same-merchant 24-hour total hits the $100 per-purchase cap on the fourth, and code denies it. Proven by 3 unit tests and a `/try` preset test.
- 392 tests passing, clean typecheck and lint.

## What we learned

- Agent payments need policy that lives outside the model; the model's best job is explaining and flagging, not holding the wallet.
- PayPal's vault plus Orders v2 is enough to build "automatic" agent payments without a new rail.
- MCP makes the integration surface tiny: four tools were enough for chat agents and cron agents alike.
- A good audit trail (decision, reason, budget left, order and capture ids) is what makes people comfortable raising limits.

## What's next

- Subscriptions: renewal reminders a few days ahead with Keep / Block, blocking a renewal that goes through Reins, and detecting PayPal billing agreements. Today Reins guards the first charge only.
- Production PayPal (live) onboarding and per-agent PayPal sub-accounts
- Complete a capture through the Agent Toolkit once a sandbox buyer approval is automated; the gate already creates orders through the real Toolkit (`docs/spikes/d5-toolkit-gate.md`)
- Real merchant checkout for agent shopping (Channel3 product search is already wired in the demo agent configs)
- Team accounts with roles, spend alerts and scheduled mandates
- More categories of unusual-pattern detection, and mandate suggestions learned from approvals
- Publish `@reins/mcp` to npm so a one-line `npx` config works (today: clone-based stdio or hosted HTTP), plus an SDK and Postman collection for non-MCP agents

## Built with (tags)

paypal, paypal-orders-v2, paypal-payouts, paypal-webhooks, paypal-transaction-search, mcp, model-context-protocol, claude, anthropic, ag-grid, ag-charts, typescript, nextjs, react, drizzle-orm, sqlite, libsql, grammy, telegram, zod, vitest, render

## Try it out links

- Code: https://github.com/sh0sub/reins
- Live demo: https://reins-web.onrender.com (try: https://reins-web.onrender.com/try)
- MCP endpoint: https://reins-mcp.onrender.com/mcp
- Video: [YouTube URL, to add after upload]

## For judges: try it in 2 minutes

No Telegram, no PayPal account, no keys needed. Free Render instances sleep, so the first load can take up to a minute.

1. **Fastest.** Open https://reins-web.onrender.com/try. Four presets ($12.98 domain: paid, $59 report: waits for you, $450 injected order: denied with the failing hard-rule table, and "Five $29 orders" to one merchant: the hard rules allow the first three and deny the fourth and fifth by the same-merchant total; with the real Claude auditor the auditor may itself deny or escalate some of the first three) plus a free-form request, all calling the same code path as the MCP `request_purchase`. Approved requests pay real sandbox payouts and the Decision panel follows them to "Paid". Tick "Simulate a fooled auditor (always AUTO_APPROVE)": the $450 order is still denied by code. The Judge tour on the page walks these in order.
2. **Connect your own Claude Code**, no key:
   ```bash
   claude mcp add --transport http reins https://reins-mcp.onrender.com/mcp
   ```
   Each MCP session gets its own throwaway demo agent, so your ledger rows never mix with another judge's. Ask: "Check my Reins mandate, then request a purchase at namecheap.com for $12.98 (item: Domain renewal, reason: production domain expires this week)." Small and allowed: paid. Then try an amount above the auto-approve limit and approve it in `/inbox`. Then try $450 at fiverr.com: denied.
3. `/overview` shows the recorded run: "This month $43.95 of $410.00 across 3 agents" (11 paid, 3 denied, R-0142 $59 pending, which you can approve yourself).
4. `/ledger` shows every decision in AG Grid: group by agent, expand a row for the audit detail. Reconciliation shows all 11 payouts as Matched.
5. `/proof` says what is real and lists the sandbox ids (order, capture, vault re-order, payouts batch, forged webhook refused), each with a run log.
6. Other clients: Claude Desktop or any stdio client can use the Agents screen config (clone the repo, `pnpm install`, replace the placeholder path with your checkout). Offline, no credentials: `pnpm install && cp .env.example .env && pnpm seed && pnpm dev:web`, or `pnpm judge` (simulated PayPal, `PAYPAL_ENV=fake`), then `pnpm judge:agent` to watch a small agent use it over MCP (PAID, PENDING, DENIED).

## Limits

- The hosted ledger is a recorded real sandbox run (11 Payouts SUCCESS, 15 real Claude audits), with times shifted by one offset so it ends about 3 minutes before boot; the chip tooltip gives the real time. Nothing in it is live traffic. Its Matched reconciliation state comes from a Transaction Search re-check on 2026-11-12, not from a live search. New requests on `/try` and over hosted MCP are live sandbox payments.
- Attack benchmark (`/try` panel, `pnpm attacks`): a simulated benchmark. The ungated side is a model that pays every request through the same simulated PayPal, not a measurement of any product; the Reins side runs the real rule engine with a fooled auditor. It proves these 9 scripted attacks, not every attack. What Reins paid ($99.98) is the in-mandate part, for example the first three of five $29 orders (benchmark rules only, no Claude auditor).
- Split-purchase rule: it adds up what the agent was paid on its own at the same merchant name within 24 hours and compares the total with the per-purchase cap. It needs a per-purchase cap on the mandate, does not count orders a person approved by hand, and does not catch splitting across different merchants (the monthly cap and the allow list still apply there).
- Agent Toolkit: `create_order` ran against the real package in the sandbox; its capture (`pay_order`) was refused with HTTP 422 until a buyer approves, so it is not claimed.
- `@reins/mcp` is not on npm (clone-based stdio config or the hosted HTTP endpoint). AG Grid Enterprise runs in trial mode (watermark). Sandbox only.

## Sponsor prizes

### Best Use of Agentic Commerce (PayPal)

**Agentic Commerce fit:** the agent is the buyer. It asks over MCP (`request_purchase`), Reins decides in code first and with Claude second, and PayPal moves the money only after both pass (Orders v2 + vault for unattended pay, Payouts for treasury mode, signed webhooks, Transaction Search reconciliation, opt-in gate for the Agent Toolkit `create_order`). Defense in depth is demonstrable in `/try`: even an auditor that always says AUTO_APPROVE cannot get the $450 order or an over-limit order paid. An agent can connect for real with one command, and `pnpm judge:agent` runs a small agent over MCP (PAID, PENDING, DENIED). The `/try` panel "Without Reins / With Reins" replays 9 scripted attacks both ways (simulated benchmark).

Reins is the control layer PayPal's supervised/automatic split implies: per-agent mandates, hard rules, an AI auditor, one-tap approval over web or Telegram, and an audit trail. It uses Orders v2 with vaulted payment for unattended purchases, Payouts for a treasury mode, signed webhooks and Transaction Search reconciliation, exposes it as an open MCP server, and can gate the PayPal Agent Toolkit's `create_order` behind the same checks.

### AG Grid

**AG Grid features used:**
- Row grouping by agent with paid-only subtotals and a pinned grand total (Enterprise)
- Master-detail rows with the full decision record (Enterprise)
- Set filters on agent, merchant, decision, status and reconciliation (Enterprise)
- **Status bar** (Enterprise): row count of the filtered grid, selected-row count, and a custom panel with Paid $, Denied $ and the sum of the ticked rows
- **Row selection** with checkboxes and a header checkbox: tick rows to sum them in the status bar
- **CSV export** ("Download CSV for accounting"): the grid's own export, filtered rows or only the ticked ones, ISO timestamps, plain numbers, columns that are hidden on a phone included
- **Saved views** (Blocked, Needs human, Paid this week) kept in the URL as `?view=`
- Card layout at 390 px, deep links into an expanded row, and AG Charts (spend per agent, category donut)

The ledger is the audit trail finance reads. A blocked request deep-links into its expanded row and offers "Tighten mandate".

### Render

A single `render.yaml` Blueprint deploys two free services, `reins-web` (dashboard, API, webhooks) and `reins-mcp` (MCP Streamable HTTP), with SQLite in `/tmp` re-seeded on boot so every judge sees a clean demo. Both are live: https://reins-web.onrender.com and https://reins-mcp.onrender.com/mcp. Health endpoints and a smoke-check script are in docs/deploy.md.
