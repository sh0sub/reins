# Devpost submission text (paste by field)

Test count at time of writing: 224 tests in 32 files (`pnpm test`), `pnpm lint` and `pnpm typecheck` clean.

---

## Pitch (put this first in "What it does" / the opening of the story)

A web page told my AI agent to buy a $450 logo. Reins blocked it: three hard rules failed in plain code before the AI auditor even weighed in, and nothing was charged.
Reins gives every agent its own PayPal wallet with a leash (monthly cap, auto-approve limit, allowed merchants), served as an open-source MCP server.
On the seeded demo month the Overview card reads "Saved you 20 approvals": 19 small, in-policy purchases paid themselves and only the over-limit ones went to a human, with one-tap approval on web or Telegram.

### PayPal APIs used (all called from `packages/core`)

| PayPal API | What Reins uses it for | Status |
|---|---|---|
| Orders v2 (`/v2/checkout/orders`, capture, `PayPal-Request-Id`) | Pay an approved request | Real sandbox: spike `docs/spikes/d2-payment.md`, COMPLETED captures. The demo video uses the fake client |
| Vault (`store_in_vault = ON_SUCCESS`, reorder with `vault_id`) | Save the buyer's PayPal once, then pay unattended | Real sandbox: VAULTED, reorder without the buyer. Video: fake client |
| Payouts (`/v1/payments/payouts`) | Prefunded "treasury" payment mode | Real sandbox: $1.00 batch and item SUCCESS (`docs/spikes/d3-payouts-webhooks.md`) |
| Webhooks (`verify-webhook-signature`) | Verify every PayPal event before storing it | Real sandbox: real and simulated events verified, forged request returns 401 (needs a public URL, so not exercised in the video) |
| Transaction Search (`/v1/reporting/transactions`) | Reconcile every capture against PayPal's records | Implemented and unit/integration tested; the sandbox app needs the Transaction Search feature enabled, and the video reconcile uses the fake client |

### Limits (read before judging)

- The demo video was recorded locally on a scratch database with the fake PayPal client (no money moves) and the offline stand-in for the Claude auditor. The real sandbox calls are in the spikes above.
- `@reins/mcp` is not published to npm; use the clone-based stdio config or the hosted HTTP endpoint.
- Free Render instances sleep after about 15 minutes and reset; open the live URL once and wait about a minute.
- AG Grid Enterprise runs in trial mode (no licence key), so the public deploy may show the trial watermark and a console notice.
- Sandbox only; no live PayPal onboarding.

---

## Project name

Reins

## Tagline (max 200 chars)

Give every AI agent a PayPal wallet with a leash: budgets, rules, one-tap human approval and an audit trail, served as an open-source MCP server any agent can call.

(160 characters.)

## Inspiration

Agents can already pay, but it is all or nothing. PayPal's own agentic-commerce docs split agent payments into supervised and automatic, yet nothing tells you which agent gets which. I let agents renew my domains, buy research and pay infra bills, and then a web page told one of them to buy a $450 logo. The question stopped being "can an agent pay?" and became "who decides how much, to whom, and what happens when it is wrong?"

Existing "agent wallet" products (Skyfire, card-network agent tokens) solve parts of this, but they need a separate wallet or crypto rails, or are closed. Reins is PayPal-native (your existing PayPal account, sandbox here), open-source, connects over MCP in minutes, and puts a human approval UX and an AI auditor that explains itself on top.

## What it does

Each agent gets its own API key and a versioned mandate: monthly cap, auto-approve limit, hard cap per purchase, allowed and blocked merchants, allowed categories. The agent connects over MCP and calls `request_purchase`. Reins answers in one of three ways:

- **Auto-approve**: hard rules pass, the Claude auditor scores risk low, and the amount is under the auto-approve limit. Reins pays right away through PayPal.
- **Ask a human**: over the limit, or the auditor is unsure. The agent gets `pending_human`. The request appears in the web inbox in real time and as a Telegram card with Approve, Approve + always allow this merchant (saves a new mandate version), and Reject. The agent polls `get_request_status` and gets its receipt.
- **Deny**: a hard rule fails (cap, block list, merchant not allowed) or the auditor sees manipulation. Nothing is charged, and the reason is explained in English and Korean.

Around that: an AG Grid ledger of every decision with grouping and drill-down, a month overview (spend vs caps, decision mix, category donut, weekly summary), receipts, unusual-pattern flags (4th request to one merchant in 24 h, quiet hours, category outside the mandate), a one-click "Tighten mandate" from a blocked request, and a demo DevOps cron agent that pays infra bills through the same MCP server.

The dashboard is built to be driven fast: a sidebar agents list with live cap use (paused agents are marked), a Cmd/Ctrl+K palette that jumps to any page, agent or request, a request drawer with the decision timeline, a hard-rule table (which rules failed and by how much), the auditor's risk and reason in English and Korean, and the raw MCP request with the key redacted, plus pause/resume and key regeneration per agent, a mandate version dropdown (every version kept, open an old one to restore it), approval cards that show the mandate check and the budget left after approving, shareable deep links (`/ledger/R-0143`, `/approvals/R-0143`, `/agents/research-scout`) and a phone-width layout down to 390 px.

## How we built it

**Monorepo, TypeScript.** `packages/core` (policy engine, PayPal client, payment strategies), `packages/db` (Drizzle on libsql/SQLite), `apps/web` (Next.js 15 dashboard, REST API and webhooks), `apps/mcp` (MCP server), `apps/bot` (grammY Telegram bot).

**Decision flow.** Hard rules run first and are plain code (monthly cap, per-purchase cap, allow/deny lists). Only then does Claude review purpose fit and risk and return a structured verdict (AUTO_APPROVE / ASK_HUMAN / DENY, risk 1 to 10). Code bounds the verdict: DENY on a model DENY or risk >= 8, AUTO_APPROVE only if the model says so, risk <= 3 and the amount is within the auto-approve limit. If the auditor times out or errors, the request goes to a human, never auto-paid. Agent-written fields are treated as untrusted data in the prompt.

**PayPal APIs (sandbox), exact endpoints used in `packages/core`:**
- `POST /v1/oauth2/token` for client-credentials tokens
- `POST /v2/checkout/orders` (Orders v2) with `PayPal-Request-Id` idempotency, and `POST /v2/checkout/orders/{id}/capture`; `GET /v2/checkout/orders/{id}`
- Orders v2 with `payment_source.paypal.attributes.vault.store_in_vault = ON_SUCCESS` for the one-time onboarding order that saves the buyer's PayPal; later purchases reorder with the saved `vault_id` and settle without the buyer present (automatic mode). A supervised mode (buyer approves each order) is also implemented.
- `POST /v1/payments/payouts` (Payouts) for a prefunded "treasury" payment mode
- `POST /v1/notifications/verify-webhook-signature` and a `/api/webhooks/paypal` endpoint that verifies every webhook (10 subscribed event types: order approved, capture completed/denied/declined, payout item succeeded/failed/blocked/returned/denied/unclaimed)
- `GET /v1/reporting/transactions` (Transaction Search) for reconciliation of every capture against PayPal's records

**MCP server, 4 tools** (Streamable HTTP and stdio): `get_mandate`, `request_purchase`, `get_request_status`, `list_transactions`. Works from Claude Desktop, Claude Code or any MCP client. The package `@reins/mcp` is in the repo but not published to npm. `request_purchase` is idempotent per agent and `client_request_id`, so retries never pay twice.

**Claude.** Claude (Anthropic SDK structured outputs) is used for: purchase audit, category suggestions for a mandate, the weekly spend summary, and the English/Korean rejection reason, plus a summary of long agent answers on the Telegram card. Without `ANTHROPIC_API_KEY` a deterministic mock auditor runs, so the whole app works with no credentials.

**AG Grid.** The ledger uses AG Grid Enterprise row grouping (toggle "group by agent" with paid-only subtotals) and master-detail (expand a row for the mandate check, auditor verdict and reason, budget left, PayPal order and capture, receipt link), with Set filters, a PayPal ID column and a reconciliation status column. AG Charts draws paid spend per agent on the ledger and the category donut on the overview.

**Render.** A Blueprint (`render.yaml`) deploys two free web services: `reins-web` (dashboard, API, webhooks) and `reins-mcp` (MCP Streamable HTTP, calling the web service by public URL). SQLite lives in `/tmp` and demo data is re-seeded on every boot, so the demo always starts clean (free instances sleep after about 15 minutes and reset).

**Testing.** 224 Vitest tests across 32 files: policy unit tests, MCP stdio test, Telegram bot handlers, webhook signature handling, reconciliation, and end-to-end integration tests for the three flows (auto-paid, human-approved, denied), merchant rules, receipts, anomalies, the DevOps agent and the AI summary.

## Challenges we ran into

- Vaulting PayPal for unattended payments in sandbox: we ran spikes to confirm that a `vault_id` reorder completes without the buyer, and documented the exact response shape.
- Keeping an LLM out of the money path: hard rules in code first, model verdict clamped by code, fail-to-human on any auditor error, no credentials or vault ids in prompts.
- Prompt injection from the agent's own input: the auditor treats the request fields as data, and the rules block it even if the model is fooled.
- Free-tier hosting: no disk and no cron on Render's free plan, so we chose SQLite in `/tmp` with a boot-time seed and made crons manual commands.
- One person, 18 days: we cut anything that did not show up in the 3-minute demo.

## Accomplishments that we're proud of

- The $450 prompt-injection purchase is blocked by three independent hard rules before the AI even weighs in, and the demo video shows it end to end over real MCP calls.
- The same approval works from the web inbox and Telegram, and "Approve + always allow" turns one human decision into a new versioned mandate.
- A judge can try it with no keys: fake PayPal mode, mock auditor, seeded data, or point their own Claude at the hosted MCP server.
- 224 passing tests, clean typecheck and lint.

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

No Telegram, no PayPal account, no keys needed. Free Render instances sleep: open the live URL once and wait about a minute. The Agents screen shows the clone-based stdio config (replace the placeholder path with your checkout); the Claude Code HTTP command below also works. See "Limits" above.

1. Open the web app. `/overview` shows "This month $117.97 of $410" across 3 seeded agents on a fresh seed; the video shows $176.97 of $410 after approving the $59 Statista request.
2. `/setup` then **Use demo merchant (sandbox)** connects the server's sandbox merchant, so the full flow works without your own PayPal keys.
3. `/agents` then create an agent and copy its `rk_live_...` key (shown once). Seeded `rk_demo_` keys are not usable.
4. Connect your own Claude. Claude Code:
   ```bash
   claude mcp add --transport http reins https://reins-mcp.onrender.com/mcp --header "Authorization: Bearer rk_live_..."
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

## Sponsor prizes

### Best Use of Agentic Commerce (PayPal)

Reins is the control layer PayPal's supervised/automatic split implies: per-agent mandates, hard rules, an AI auditor, one-tap approval over web or Telegram, and an audit trail. It uses Orders v2 with vaulted payment for unattended purchases, Payouts for a treasury mode, signed webhooks and Transaction Search reconciliation, and exposes it all as an open MCP server so Claude Desktop, Claude Code and cron agents can spend within limits.

### AG Grid

The ledger is the product's audit trail, built on AG Grid Enterprise: row grouping by agent with paid-only subtotals, master-detail rows showing the full decision record (mandate check, auditor verdict and reason, budget left, PayPal order and capture), and Set filters, with AG Charts for spend per agent and the overview category donut. A blocked request deep-links into its expanded ledger row and offers one-click "Tighten mandate". The demo video shows grouping, drill-down and the chart.

### Render

Reins deploys from a single `render.yaml` Blueprint on the free plan: `reins-web` (Next.js dashboard, REST API, PayPal and Telegram webhooks) and `reins-mcp` (MCP Streamable HTTP so any agent connects with one URL). Costs nothing, no disk and no cron, with SQLite in `/tmp` re-seeded on boot so every judge sees a clean demo. Health endpoints and a smoke-check script are documented in docs/deploy.md.
