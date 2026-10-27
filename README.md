# reins

**Reins** gives every AI agent a PayPal wallet with a leash: budgets, rules, one-tap human approval and a full audit trail, exposed as an MCP server any agent can call.

Built for the PayPal AI Hackathon 2026 (deadline 2026-11-12 PST). Targets: Best Use of Agentic Commerce, AG Grid.

- Agent calls `request_purchase` over MCP (stdio or Streamable HTTP)
- Hard rules first (monthly cap, per-purchase auto-approve limit, allow/deny lists), then Claude reviews purpose fit and risk: AUTO_APPROVE / ASK_HUMAN / DENY
- ASK_HUMAN sends a Telegram card and a web inbox item; one tap decides
- Approved purchases settle through PayPal Orders v2 (sandbox) and land in an AG Grid ledger

## Status

Backend core in progress (2026-10-27): policy engine (hard rules + Claude auditor), Reins MCP server, PayPal Orders/Payouts/Webhooks client, Telegram approval handlers, web approvals inbox and mandate editor. Sandbox spikes are scripted but not run yet.

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
```

Sandbox spikes (need keys in `.env`, write results to `docs/spikes/`):

```bash
pnpm spike scripts/spikes/d2-payment.ts           # #33 #27 #28 order/capture + vault_id
pnpm spike scripts/spikes/payee-email.ts          # #29 payee.email_address
pnpm spike scripts/spikes/d3-payouts-webhooks.ts  # #34 payouts + webhook verify
pnpm spike scripts/spikes/channel3.ts             # #31 Channel3 search
```

Layout: `apps/web` (Next.js 15 UI + REST + webhooks), `apps/mcp` (MCP server), `apps/bot` (grammY handlers), `packages/core` (policy, PayPal client, payment strategies), `packages/db` (Drizzle, SQLite/libsql locally).

## License

MIT
