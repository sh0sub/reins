# Devpost submission text (paste by field)

Test count at time of writing: 362 tests (`pnpm test`), `pnpm lint` and `pnpm typecheck` clean.

---

## Judge TL;DR (paste first)

1. **A web page told my AI agent to buy a $450 logo. A shared PayPal credential would have paid it. Reins blocked it in code, before any money moved.** Reins gives every agent its own mandate, hard rules, a Claude audit, one-tap approval and an audit ledger, served as an open-source MCP server on PayPal.
2. **11 of 15 paid without a tap / $450 injection blocked / 7 min saved** (the hosted demo ledger is a recorded real run on the PayPal sandbox, computed from the ledger; the 7 minutes are 14 approvals at an assumed 30 s each). In a simulated benchmark of 9 scripted attacks (`pnpm attacks`, auditor set to approve everything) an ungated agent paid $813.96 and the same attacks through Reins paid $99.98, the part that was inside the mandate.
3. **Try in 60 s, no keys:** `pnpm judge` (opens `/try`; real vs simulated PayPal is badged everywhere; `/proof` says what is real, and the sandbox ids are there and in the API table below). The hosted demo makes real sandbox payments; `pnpm judge` simulates new ones. Then `pnpm judge:agent` to watch an agent use it over MCP.

Tests: 362 passing, `pnpm typecheck` and `pnpm lint` clean.

**Agentic Commerce fit:** the agent is the buyer; it asks over MCP, code decides first, Claude second, and PayPal moves money only after both pass. **AG Grid features used:** row grouping with paid-only subtotals, master-detail, Set filters, a status bar with money totals and selected-row sum, row selection, CSV export for accounting, saved views, and AG Charts (details under Sponsor prizes).

---

## Pitch (put this first in "What it does" / the opening of the story)

A shared PayPal credential would have paid the $450. Reins did not.
A web page told my AI agent to buy a $450 logo. Reins blocked it: three hard rules failed in plain code before the AI auditor even weighed in, and nothing was charged.
Reins gives every agent its own PayPal wallet with a leash (monthly cap, auto-approve limit, allowed merchants), served as an open-source MCP server.
On the recorded run the Overview card reads "Saved you 14 approvals": 11 small, in-policy purchases paid themselves (real sandbox payouts) and the $59 over-limit one waits for a human, with one-tap approval on web or Telegram.

**Verified in the real PayPal sandbox** (ids are in the API table below and on `/proof`):
- Orders v2 order COMPLETED and captured, buyer's PayPal vaulted.
- Buyer-absent re-order with only a `vault_id`: COMPLETED.
- The hosted demo ledger is a recorded real run: 15 requests through MCP, hard rules and real Claude audits (15 audits), 11 Payouts SUCCESS with real batch and transaction ids. Nothing in the seed is invented; every row carries a "recorded run" chip.
- Payouts batch and item SUCCESS; the signed `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` webhook was verified, a forged one got 401.
- Agent Toolkit 1.11.0: `create_order` made a sandbox order after Reins approved it; a $450 request made 0 Toolkit calls. Toolkit capture (`pay_order`) was refused with HTTP 422 until a buyer approves, so it is not shown as completed.

**Why it matters for PayPal merchants**
- A business that lets an agent pay from its PayPal account today hands over one credential with no per-agent limit; Reins puts a per-agent mandate and a human approval in front of every Orders v2 call.
- Every decision, denials included, lands in a ledger with PayPal order and capture IDs reconciled against Transaction Search, so finance can see what each agent bought and why.
- It is the spending-controls layer that PayPal's supervised/automatic split implies, built only on public sandbox APIs. See "Who it is for and why now" below.

Sandbox only; the hosted ledger is a recorded real run, while the video's main run was recorded earlier on the old scripted seed with simulated PayPal, and one badged segment is a real sandbox run (details in "Limits"). The judge path ("For judges") comes before "Limits".

### Case study: money protected (recorded run)

The Overview "Money protected" card is computed from the ledger, not typed in. On the seed: worst-case exposure is $410 a month (sum of three agent caps) where one shared unlimited key has no bound; $1,769 blocked in 3 requests (largest R-0137, a $1,295 office chair; the $450 fiverr.com prompt injection is R-0143, 3 hard rules failed, Claude advisory risk 10); 11 of 15 requests paid without a tap; (11 auto + 3 blocked) = 14 approvals x 30 s = 7 minutes saved, where 30 s per approval is a stated assumption, not a measurement. The ledger is a recorded real sandbox run (real payouts, real Claude audits, times shifted so it ends about 3 minutes before boot; the chip tooltip gives the real time), not live traffic. Nobody approved anything in it; R-0142 ($59 statista report, Claude ASK_HUMAN) is pending so a judge can approve it.

### PayPal APIs used (all called from `packages/core`; the real sandbox ids behind them are listed on the `/proof` page)

| PayPal API | What Reins uses it for | Verified in real sandbox | Notes |
|---|---|---|---|
| Orders v2 (`/v2/checkout/orders`, capture, `PayPal-Request-Id`) + Vault (`store_in_vault = ON_SUCCESS`, reorder with `vault_id`) | Pay an approved request; save the buyer's PayPal once, then pay unattended | Yes | Order `04X61877K0529583E`, capture `03A015968J4767410`, vault re-order `880199579M655730R` (COMPLETED, without the buyer): `docs/spikes/d2-payment.md`. The video's main run used the simulated client |
| Payouts (`/v1/payments/payouts`) | Prefunded "treasury" payment mode | Yes | Spike batch `UALE8USQRMHYW`, $1.00, batch and item SUCCESS (`docs/spikes/d3-payouts-webhooks.md`). The hosted demo ledger is a recorded real run: 11 payout batches, all SUCCESS (for example batch `H7LNJFK5HG4EQ`, transaction `6Y412580GH7713740`), paid to a sandbox personal account; the hosted `/try` runs treasury mode (`PAYPAL_PAYMENT_MODE=treasury`), so an approved request pays a real sandbox payout with no buyer login, settled by reading the payout and the payout-item webhook |
| Webhooks (`verify-webhook-signature`) | Verify every PayPal event before storing it | Yes | Real and simulated events verified, forged request returns 401; needs a public URL, so not in the video |
| Transaction Search (`/v1/reporting/transactions`) | Reconcile every capture against PayPal's records | No | Real API calls are made by Reconcile now and the cron. In the recorded run PayPal returned 0 transactions (sandbox lag), so the 11 payouts show "Not checked yet"; nothing is claimed as matched. Unit and integration tested |
| Agent Toolkit tools `create_order`, `pay_order` (capture) (opt-in `reinsGate`) | Run a Toolkit order only after the mandate and rules pass | Yes for `create_order`; capture not completed | Real `@paypal/agent-toolkit` 1.11.0: an approved request created a sandbox order through the Toolkit, a denied one made 0 Toolkit calls. Its `pay_order` capture was refused by PayPal (HTTP 422) because the buyer had not approved; that approval needs a sandbox buyer login. Run log and the four fixes it forced: `docs/spikes/d5-toolkit-gate.md` (mock auditor in that run) |

---

## Project name

Reins

## Tagline (max 200 chars)

Give every AI agent a PayPal wallet with a leash: budgets, rules, one-tap human approval and an audit trail, served as an open-source MCP server any agent can call.

(160 characters.)

## Inspiration

Agents can already pay, but it is all or nothing. PayPal's own agentic-commerce docs split agent payments into supervised and automatic, yet nothing tells you which agent gets which. I let agents renew my domains, buy research and pay infra bills, and then a web page told one of them to buy a $450 logo. The question stopped being "can an agent pay?" and became "who decides how much, to whom, and what happens when it is wrong?"

Existing "agent wallet" products (Skyfire, card-network agent tokens) solve parts of this, but they need a separate wallet or crypto rails, or are closed. Reins is PayPal-native (your existing PayPal account, sandbox here), open-source, connects over MCP in minutes, and puts a human approval UX and an AI auditor that explains itself on top.

### Who it is for and why now

- **Solo developer with cron agents.** A domain-renewal bot, a research agent and an infra-bill agent each get their own key, monthly cap and allowed-merchant list instead of sharing one card. One tap approves the odd over-limit purchase from Telegram.
- **Small business ops with a purchasing agent.** A restock or SaaS-renewal agent buys within a mandate; anything over the auto-approve limit waits in an inbox for the owner, and every decision is in an audit ledger for the books.
- **Platform enabling agents for its sellers.** A marketplace or tooling platform that lets each seller's agent spend can give every agent its own versioned mandate and approval trail, behind one MCP endpoint.

**Why now.** Gartner predicts that by 2028 15% of day-to-day work decisions will be made autonomously by agentic AI (up from 0% in 2024) and that 33% of enterprise software applications will include agentic AI; it also predicts over 40% of agentic AI projects will be canceled by the end of 2027. Source as reported by SD Times: https://sdtimes.com/agentic-ai/gartner-more-than-40-of-agentic-ai-projects-will-be-canceled-in-next-few-years/ . These are analyst forecasts, not Reins measurements.

**How PayPal could adopt it.** The mandate (cap, auto-approve limit, allowed merchants, versioned) is a small, API-shaped object, so PayPal could offer it as a native spending-controls primitive on agent credentials, with Reins as the open reference implementation.

**Roadmap.** (1) Publish `@reins/mcp` to npm so a one-line `npx` config works. (2) Production PayPal onboarding beyond sandbox. (3) Complete a capture through the Agent Toolkit once a sandbox buyer approval is automated; the gate already creates orders through the real `@paypal/agent-toolkit` in the sandbox (`docs/spikes/d5-toolkit-gate.md`).

## How it compares

| | Reins | Skyfire / card-network agent tokens | Bare PayPal Agent Toolkit |
|---|---|---|---|
| Per-agent mandate (limits, merchants, window) | Yes, versioned per agent | Per-agent wallet or token | No, one set of API credentials |
| Hard rules enforced in code, before any money moves | Yes, deterministic | Limits on the token or wallet | No |
| AI audit with a written explanation | Yes, Claude, advisory on top of the rules | No | No |
| Human one-tap approval (Telegram / web) | Yes | Varies | No |
| Open source, MCP, PayPal-native | Yes, MIT-style repo, MCP server | Mostly closed, separate wallet or rails | Open source, PayPal-native |
| Compose: gate the Toolkit | Yes, opt-in: `reinsGate` runs the Toolkit's `create_order` only after mandate, rules and audit pass (run against the real Toolkit in the sandbox; unit tests too) | n/a | This is the layer being gated |

**Works with the PayPal Agent Toolkit.** Reins is the policy and approval layer in front of PayPal payments. By default Reins creates the sandbox order itself; with the opt-in adapter (`packages/core/src/pay/toolkit.ts`, example in the README) an approved request is created through the Toolkit's `create_order` (its capture tool `pay_order` is wired, but a completed capture is not shown), and a denied or held request never reaches the Toolkit. Run against the real `@paypal/agent-toolkit` 1.11.0 in the sandbox (`docs/spikes/d5-toolkit-gate.md`): the approved request created a PayPal order through the Toolkit's `create_order`, the denied one made zero Toolkit calls. The Toolkit's capture tool (`pay_order`) was called but PayPal refused it until the buyer approves on the sandbox login page, so a completed capture through the Toolkit is not shown. Only approval-link (supervised) orders are supported.

### Where Reins sits in PayPal's agentic commerce

PayPal is building the rails for agents that shop: it announced support for Google's Agent Payments Protocol (AP2) on Sept 16, 2025, launched agentic commerce services for merchants on Oct 28, 2025, and offers the Agent Toolkit and MCP servers so agents can call PayPal APIs. AP2's Intent Mandate captures what a user pre-approves for an agent that acts while they are away (conditions such as budget or timing). Reins is the buyer-side piece that enforces such a mandate: before any PayPal call, the mandate becomes deterministic hard rules in code, then an AI audit, then a human approval when the rules say so. Reins does not implement the AP2 protocol or its signed mandates; it uses the same idea of a mandate and enforces it at the moment of payment.

- **AP2 (Sept 2025):** defines Intent, Cart and Payment Mandates as signed proof of what the user authorized ([PayPal developer blog](https://developer.paypal.com/community/blog/PayPal-Agent-Payments-Protocol/)). Reins turns the same kind of intent (limits, merchants, window, categories) into rules that code checks on every request.
- **Agentic commerce services / Agent Ready (Oct 2025):** help merchants get discovered and accept payments on AI surfaces ([PayPal newsroom](https://newsroom.paypal-corp.com/2025-10-28-PayPal-Launches-Agentic-Commerce-Services-to-Power-AI-Driven-Shopping)). That is the seller side; Reins sits on the buyer's side and decides whether the agent may pay at all.
- **Agent Toolkit and MCP servers (2025):** give an agent the PayPal tools ([PayPal developer blog](https://developer.paypal.com/community/blog/paypal-agentic-ai-toolkit/)). Reins gates them: with `reinsGate`, the Toolkit's `create_order` runs only after the mandate, rules and audit pass.

## What it does

Each agent gets its own API key and a versioned mandate: monthly cap, auto-approve limit, hard cap per purchase, allowed and blocked merchants, allowed categories. The agent connects over MCP and calls `request_purchase`. Reins answers in one of three ways:

- **Auto-approve**: hard rules pass, the Claude auditor scores risk low, and the amount is under the auto-approve limit. Reins pays right away through PayPal.
- **Ask a human**: over the limit, or the auditor is unsure. The agent gets `pending_human`. The request appears in the web inbox in real time and as a Telegram card with Approve, Approve + always allow this merchant (saves a new mandate version), and Reject. The agent polls `get_request_status` and gets its receipt.
- **Deny**: a hard rule fails (cap, block list, merchant not allowed, or orders to one merchant adding up past the per-purchase cap within 24 hours) or the auditor sees manipulation. Nothing is charged, and the reason is explained in plain English (a Korean version is stored and shown for a Korean locale).

Around that: an AG Grid ledger of every decision with grouping and drill-down, a month overview (spend vs caps, decision mix, category donut, weekly summary), receipts, unusual-pattern flags (4th request to one merchant in 24 h, quiet hours, category outside the mandate), a one-click "Tighten mandate" from a blocked request, and a demo DevOps cron agent that pays infra bills through the same MCP server.

The dashboard is built to be driven fast: a sidebar agents list with live cap use (paused agents are marked), a Cmd/Ctrl+K palette that jumps to any page, agent or request, a request drawer with the decision timeline, a hard-rule table (which rules failed and by how much), the auditor's risk and reason, and the raw MCP request with the key redacted, plus pause/resume and key regeneration per agent, a mandate version dropdown (every version kept, open an old one to restore it), approval cards that show the mandate check and the budget left after approving, shareable deep links (`/ledger/R-0143`, `/approvals/R-0143`, `/agents/research-scout`) and a phone-width layout down to 390 px (the AG Grid ledger turns into one card per request there).

## How we built it

**Monorepo, TypeScript.** `packages/core` (policy engine, PayPal client, payment strategies), `packages/db` (Drizzle on libsql/SQLite), `apps/web` (Next.js 15 dashboard, REST API and webhooks), `apps/mcp` (MCP server), `apps/bot` (grammY Telegram bot).

**Decision flow.** Hard rules run first and are plain code (monthly cap, per-purchase cap, a same-merchant 24-hour total against that cap, allow/deny lists, velocity). Only then does Claude review purpose fit and risk and return a structured verdict (AUTO_APPROVE / ASK_HUMAN / DENY, risk 1 to 10). Code bounds the verdict: DENY on a model DENY or risk >= 8, AUTO_APPROVE only if the model says so, risk <= 3 and the amount is within the auto-approve limit. If the auditor times out or errors, the request goes to a human, never auto-paid. Agent-written fields are treated as untrusted data in the prompt.

**PayPal APIs (sandbox), exact endpoints used in `packages/core`:**
- `POST /v1/oauth2/token` for client-credentials tokens
- `POST /v2/checkout/orders` (Orders v2) with `PayPal-Request-Id` idempotency, and `POST /v2/checkout/orders/{id}/capture`; `GET /v2/checkout/orders/{id}`
- Orders v2 with `payment_source.paypal.attributes.vault.store_in_vault = ON_SUCCESS` for the one-time onboarding order that saves the buyer's PayPal; later purchases reorder with the saved `vault_id` and settle without the buyer present (automatic mode). A supervised mode (buyer approves each order) is also implemented.
- `POST /v1/payments/payouts` (Payouts) for a prefunded "treasury" payment mode, and `GET /v1/payments/payouts/{id}` to settle a payout (SUCCESS paid; FAILED, DENIED, BLOCKED, RETURNED, REFUNDED, REVERSED failed; UNCLAIMED stays committed and shows "Payout unclaimed")
- `POST /v1/notifications/verify-webhook-signature` and a `/api/webhooks/paypal` endpoint that verifies every webhook (10 subscribed event types: order approved, capture completed/denied/declined, payout item succeeded/failed/blocked/returned/denied/unclaimed)
- `GET /v1/reporting/transactions` (Transaction Search) for reconciliation of every capture against PayPal's records

**MCP server, 4 tools** (Streamable HTTP and stdio): `get_mandate`, `request_purchase`, `get_request_status`, `list_transactions`. Works from Claude Desktop, Claude Code or any MCP client. The package `@reins/mcp` is in the repo but not published to npm. `request_purchase` is idempotent per agent and `client_request_id`, so retries never pay twice.

**Claude.** Claude (Anthropic SDK structured outputs) is used for: purchase audit, category suggestions for a mandate, the weekly spend summary, and the rejection reason, plus a summary of long agent answers on the Telegram card. Without `ANTHROPIC_API_KEY` a deterministic mock auditor runs, so the whole app works with no credentials.

**AG Grid.** The ledger uses AG Grid Enterprise row grouping (toggle "group by agent" with paid-only subtotals) and master-detail (expand a row for the mandate check, auditor verdict and reason, budget left, PayPal order and capture, receipt link), with Set filters, a PayPal ID column and a reconciliation status column. AG Charts draws paid spend per agent on the ledger and the category donut on the overview.

**Render.** A Blueprint (`render.yaml`) deploys two free web services: `reins-web` (dashboard, API, webhooks) and `reins-mcp` (MCP Streamable HTTP, calling the web service by public URL). SQLite lives in `/tmp` and demo data (the recorded run) is re-seeded on every boot, so the demo always starts clean (free instances sleep after about 15 minutes and reset).

**Testing.** 362 Vitest tests: policy unit tests (including the split-purchase rule), MCP stdio test, Telegram bot handlers, webhook signature handling, reconciliation, and end-to-end integration tests for the three flows (auto-paid, human-approved, denied), merchant rules, receipts, anomalies, the DevOps agent and the AI summary.

## Challenges we ran into

- Vaulting PayPal for unattended payments in sandbox: we ran spikes to confirm that a `vault_id` reorder completes without the buyer, and documented the exact response shape.
- Keeping an LLM out of the money path: hard rules in code first, model verdict clamped by code, fail-to-human on any auditor error, no credentials or vault ids in prompts.
- Prompt injection from the agent's own input: the auditor treats the request fields as data, and the rules block it even if the model is fooled.
- Free-tier hosting: no disk and no cron on Render's free plan, so we chose SQLite in `/tmp` with a boot-time seed and made crons manual commands.
- One person, 18 days: we cut anything that did not show up in the 3-minute demo.

## Accomplishments that we're proud of

- The $450 prompt-injection purchase is blocked by three independent hard rules before the AI even weighs in, and the demo video shows it end to end over real MCP calls, and the hosted ledger holds it as R-0143 in a recorded real run.
- The same approval works from the web inbox and Telegram, and "Approve + always allow" turns one human decision into a new versioned mandate.
- A judge can try it with no keys: fake PayPal mode, mock auditor, the recorded-run seed, or point their own Claude at the hosted MCP server.
- 362 passing tests, clean typecheck and lint.
- A split-purchase guard: five $29 orders to one merchant stay under a $30 auto-approve limit one by one, but the same-merchant 24-hour total hits the $100 per-purchase cap on the fourth, and code denies it. Proven by 3 unit tests and a `/try` preset test; see "Limits" for what it does not cover.

## What we learned

- Agent payments need policy that lives outside the model; the model's best job is explaining and flagging, not holding the wallet.
- PayPal's vault plus Orders v2 is enough to build "automatic" agent payments without a new rail.
- MCP makes the integration surface tiny: four tools were enough for chat agents and cron agents alike.
- A good audit trail (decision, reason, budget left, order and capture ids) is what makes people comfortable raising limits.

## What's next

- Production PayPal (live) onboarding and per-agent PayPal sub-accounts
- Real merchant checkout for agent shopping (Channel3 product search is already wired in the demo agent configs)
- Team accounts with roles, spend alerts and scheduled mandates
- More categories of unusual-pattern detection, and mandate suggestions learned from approvals
- Publish `@reins/mcp` to npm so a one-line `npx` config works (today: clone-based stdio or hosted HTTP), plus an SDK and Postman collection for non-MCP agents

## Built with (tags)

paypal, paypal-orders-v2, paypal-payouts, paypal-webhooks, paypal-transaction-search, mcp, model-context-protocol, claude, anthropic, ag-grid, ag-charts, typescript, nextjs, react, drizzle-orm, sqlite, libsql, grammy, telegram, zod, vitest, render

## Try it out links

- Code: https://github.com/sh0sub/reins
- Live demo: https://reins-web.onrender.com (to confirm after deploy)
- MCP endpoint: https://reins-mcp.onrender.com/mcp (to confirm after deploy)
- Video: [YouTube URL, to add after upload]

## For judges: try it in 2 minutes

(Also linked from the top of this description; see "Limits" above.) No Telegram, no PayPal account, no keys needed. Free Render instances sleep: open the live URL once and wait about a minute. The Agents screen shows the clone-based stdio config (replace the placeholder path with your checkout); the Claude Code HTTP command below also works.

0. **Fastest:** open `/try` (live) or run `pnpm judge` locally. Four presets ($12.98 domain: paid, $59 report: waits for you, $450 injected order: denied with the failing hard-rule table, and "Five $29 orders" to one merchant: the hard rules allow the first three and deny the fourth and fifth by the same-merchant total; with the real Claude auditor on the hosted demo, the auditor may itself deny or escalate some of the first three as split-order behaviour) plus a free-form request, calling the same code path as the MCP `request_purchase`. Tick "Simulate a fooled auditor (always AUTO_APPROVE)": the $450 order is still denied by code. A three-step Judge tour on the page walks these in order and ends with links to the ledger row and audit trail. On the hosted demo, approved `/try` requests pay real sandbox payouts (treasury mode); with `pnpm judge` they are simulated and labelled `SIM-…`. `/proof` says which is which and lists the earlier spike-run ids (order, capture, vault re-order, payouts batch, forged webhook refused), labelled as recorded, not live. Playground requests stay out of the Overview numbers by default.
1. Open the web app. `/overview` shows "This month $43.95 of $410.00 across 3 agents" on a fresh seed (the recorded run: 11 paid, 3 denied, R-0142 $59 pending, which you can approve yourself). The demo video was recorded earlier on the old scripted seed, so its numbers (for example $176.97) differ.
2. `/setup` then **Use demo merchant (sandbox)** connects the server's sandbox merchant, so the full flow works without your own PayPal keys.
3. Connect your own Claude, no key needed. Claude Code:
   ```bash
   claude mcp add --transport http reins https://reins-mcp.onrender.com/mcp
   ```
   Each MCP session gets its own throwaway demo key for the Playground Agent, so your velocity window and ledger rows never mix with another judge's.
4. Second option, with a key: copy your own `rk_demo_` key from "Connect your own agent" on `/try` (or an `rk_live_...` key on a deployment you run):
   ```bash
   claude mcp add --transport http reins https://reins-mcp.onrender.com/mcp --header "Authorization: Bearer rk_demo_..."
   ```
   Claude Desktop / any stdio client (clone the repo, `pnpm install`):
   ```json
   {
     "mcpServers": {
       "reins": {
         "command": "npx",
         "args": ["-y", "tsx", "/ABSOLUTE/PATH/TO/reins/apps/mcp/src/stdio.ts"],
         "env": { "REINS_API_URL": "https://reins-web.onrender.com", "REINS_API_KEY": "rk_live_..." }
       }
     }
   }
   ```
5. Ask Claude: "Check my Reins mandate, then request a purchase at namecheap.com for $12.98 (item: Domain renewal, reason: production domain expires this week)." Small and allowed: paid. Then try an amount above the auto-approve limit and approve it in `/inbox` (no Telegram needed). Then try $450 at fiverr.com: denied.
6. `/ledger` shows every decision in AG Grid: group by agent, expand a row for the audit detail.

Run it locally with zero credentials: `pnpm install && cp .env.example .env && pnpm seed && pnpm dev:web` (`PAYPAL_ENV=fake`).

## Limits

- The hosted demo ledger is a recorded real sandbox run (11 Payouts SUCCESS, 15 real Claude audits), with times shifted by one offset so it ends about 3 minutes before boot; nothing in it is live. Transaction Search returned 0 transactions at record time (sandbox lag), so reconciliation is not yet matched. The video's main run was recorded earlier on the old scripted seed, locally on a scratch database, with the simulated PayPal client and the offline stand-in for the Claude auditor; the segment badged "REAL RUN" (about 10 s, see `docs/submission/checklist.md`) used the real sandbox with real Claude audits. Other real sandbox calls: the spikes above.
- Attack benchmark (`/try` panel, `pnpm attacks`): a simulated benchmark. The ungated side is a model that pays every request through the same simulated PayPal, not a measurement of any product; the Reins side runs the real rule engine with a fooled auditor. It proves these 9 scripted attacks, not every attack. What Reins paid ($99.98) is the in-mandate part, for example the first three of five $29 orders (benchmark rules only, no Claude auditor).
- Split-purchase rule: it adds up what the agent was paid on its own at the same merchant name within 24 hours and compares the total with the per-purchase cap. It needs a per-purchase cap on the mandate, does not count orders a person approved by hand, and does not catch splitting across different merchants (the monthly cap and the allow list still apply there).
- Agent Toolkit: `create_order` ran against the real package in the sandbox; its capture (`pay_order`) was refused with HTTP 422 until a buyer approves, so it is not claimed.
- `@reins/mcp` is not on npm (clone-based stdio config or the hosted HTTP endpoint). Free Render instances sleep: open the live URL once and wait about a minute. AG Grid Enterprise runs in trial mode (watermark). Sandbox only.

## Sponsor prizes

### Best Use of Agentic Commerce (PayPal)

**Agentic Commerce fit:** the agent is the buyer. It asks over MCP (`request_purchase`), Reins decides in code first and with Claude second, and PayPal moves the money only after both pass (Orders v2 + vault for unattended pay, Payouts for treasury mode, signed webhooks, Transaction Search reconciliation, opt-in gate for the Agent Toolkit `create_order`). Defense in depth is demonstrable in `/try`: even an auditor that always says AUTO_APPROVE cannot get the $450 order or an over-limit order paid. An agent can connect for real: `/try` and Settings show a copy-paste MCP config and a curl pre-filled with the demo key, and `pnpm judge:agent` runs a small agent over MCP (PAID, PENDING, DENIED). The `/try` panel "Without Reins / With Reins" replays 9 scripted attacks both ways (simulated benchmark).

Reins is the control layer PayPal's supervised/automatic split implies: per-agent mandates, hard rules, an AI auditor, one-tap approval over web or Telegram, and an audit trail. It uses Orders v2 with vaulted payment for unattended purchases, Payouts for a treasury mode, signed webhooks and Transaction Search reconciliation, exposes it as an open MCP server, and can gate the PayPal Agent Toolkit's `create_order` behind the same checks (run against the real Toolkit in the sandbox for `create_order`; capture not completed).

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

The ledger is the audit trail, built on AG Grid Enterprise: row grouping by agent with paid-only subtotals, master-detail rows with the full decision record (mandate check, auditor verdict, budget left, PayPal order and capture), Set filters, and AG Charts for spend per agent and the category donut. A blocked request deep-links into its expanded row and offers "Tighten mandate".

### Render

A single `render.yaml` Blueprint deploys two free services, `reins-web` (dashboard, API, webhooks) and `reins-mcp` (MCP Streamable HTTP), with SQLite in `/tmp` re-seeded on boot so every judge sees a clean demo. Health endpoints and a smoke-check script are in docs/deploy.md.
