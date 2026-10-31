# reins

**Reins** gives every AI agent a PayPal wallet with a leash: budgets, rules, one-tap human approval and a full audit trail, exposed as an MCP server any agent can call.

Built for the PayPal AI Hackathon 2026 (deadline 2026-11-12 PST). Targets: Best Use of Agentic Commerce, AG Grid.

- Agent calls `request_purchase` over MCP (stdio or Streamable HTTP)
- Hard rules first (monthly cap, per-purchase auto-approve limit, allow/deny lists), then Claude reviews purpose fit and risk: AUTO_APPROVE / ASK_HUMAN / DENY
- ASK_HUMAN sends a Telegram card and a web inbox item; one tap decides
- Approved purchases settle through PayPal Orders v2 (sandbox) and land in an AG Grid ledger

## Status

D10 checkpoint (2026-10-29): plan flow B runs end to end (AUTO paid, ASK_HUMAN approved on web or Telegram, DENY blocked),
covered by `tests/integration/checkpoint.test.ts`. Sandbox spikes ran on 2026-10-27/28 (vault auto-pay, payouts, webhook
signatures OK; results in `docs/spikes/`).

Should features (2026-10-31, `tests/integration/{merchant-rule,receipt,anomalies,devops-agent,ask-summary}.test.ts`):
S5 "Approve + always allow this merchant" (web inbox + Telegram; saves a mandate version with a per-merchant auto-approve limit),
S4 receipts (`receipt.receipt_url` returned over MCP, page at `/receipts/:id`), S3 unusual patterns (4th request to one merchant in
24h, quiet hours via `REINS_QUIET_HOURS`/`REINS_TIMEZONE`, category outside the mandate: risk +, AUTO becomes ASK_HUMAN, never blocks
alone), S6 DevOps cron agent (`pnpm agent:devops`), S2 AI summary of long agent answers on the Telegram card.

## Develop

```bash
pnpm install
cp .env.example .env        # PAYPAL_ENV=fake runs without any keys
# apps/web reads the root .env through `node --env-file-if-exists=../../.env` (see apps/web/package.json),
# so keep a single .env at the repo root. Fill it with scripts/setup-env.sh (never echoes secrets).
pnpm test                   # vitest: unit + tests/integration
pnpm typecheck && pnpm lint
pnpm dev:web                # http://localhost:3000 (API under /api)
pnpm mcp:stdio              # MCP over stdio (REINS_API_KEY=rk_live_...)
pnpm mcp:http               # MCP over Streamable HTTP on :3333/mcp
pnpm tokens                 # regenerate design tokens CSS
pnpm reconcile              # M11 nightly Transaction Search reconciliation (Render Cron), counts only
pnpm telegram:check         # #9 real bot check: getMe, finds your /start, sends one demo card
```

Screens: `/overview` (S7 home: month spend vs caps, decision mix, category donut, recent decisions, AI weekly summary), `/setup` (S1 connect PayPal, payment mode, Telegram), `/agents` (S2 mandates), `/inbox` (S5 approvals with Ask agent),
`/ledger` (S4 AG Grid + AG Charts). Telegram uses long polling when `PUBLIC_BASE_URL` is not https, so approval buttons
work locally without a tunnel. Demo walkthrough: [docs/demo-checkpoint.md](docs/demo-checkpoint.md).

Sandbox spikes (need keys in `.env`, write results to `docs/spikes/`):

```bash
pnpm spike scripts/spikes/d2-payment.ts           # #33 #27 #28 order/capture + vault_id
pnpm spike scripts/spikes/payee-email.ts          # #29 payee.email_address
pnpm spike scripts/spikes/d3-payouts-webhooks.ts  # #34 payouts + webhook verify
pnpm spike scripts/spikes/channel3.ts             # #31 Channel3 search
```

Layout: `apps/web` (Next.js 15 UI + REST + webhooks), `apps/mcp` (MCP server), `apps/bot` (grammY handlers), `packages/core` (policy, PayPal client, payment strategies), `packages/db` (Drizzle, SQLite/libsql locally).

## Demo data

```bash
pnpm seed                        # 3 agents, 3 mandates, 24 requests in apps/web/.local/reins.db (what `pnpm dev:web` uses)
pnpm seed -- --db ./scratch.db   # another file; point the app at it with DATABASE_URL=file:./scratch.db
pnpm seed -- --force             # also run against a DB that has real data (only the seed rows are replaced)
```

Matches the plan's flow C: "This month $117.97 of $410 across 3 agents" (limits $150 / $100 / $160), with auto-paid, human-approved,
human-rejected, hard-rule-blocked (the $450 fiverr.com injection), auditor-blocked, failed, expired and 2 pending items across this and last month.
No PayPal or Claude calls (fake `FAKE-ORDER-*` / `FAKE-CAPTURE-*` ids). Seed agents use `rk_demo_` keys that are never stored or printed, so create
a fresh agent for live MCP runs. Re-running replaces only seed rows and refuses a DB with other data unless `--force`. Pending approvals
expire after `REINS_APPROVAL_TTL_MINUTES` (default 30), so re-seed right before a demo.

## Demo agent A (Claude Desktop / Claude Code)

Config snippets that expose the 4 Reins MCP tools (plus Channel3 product search) to Claude Desktop (`agents/claude_desktop_config.json`) and Claude Code (`.mcp.json.example`). Setup steps and demo prompts: [agents/README.md](agents/README.md).

## Demo agent B (DevOps cron)

`pnpm agent:devops` checks `agents/devops/infra-costs.json`, pays bills due in the next 3 days that fit the auto-approve limit through
the Reins MCP stdio server, and leaves bigger ones for you (`--ask` requests them for approval, `--dry-run` only reports). Idempotency
keys are per bill and month, so a second run the same day pays nothing. Details: [agents/README.md](agents/README.md#demo-agent-b-devops-cron).

## License

MIT
