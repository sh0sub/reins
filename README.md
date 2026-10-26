# reins

**Reins** gives every AI agent a PayPal wallet with a leash: budgets, rules, one-tap human approval and a full audit trail, exposed as an MCP server any agent can call.

Built for the PayPal AI Hackathon 2026 (deadline 2026-11-12 PST). Targets: Best Use of Agentic Commerce, AG Grid.

- Agent calls `request_purchase` over MCP (stdio or Streamable HTTP)
- Hard rules first (monthly cap, per-purchase auto-approve limit, allow/deny lists), then Claude reviews purpose fit and risk: AUTO_APPROVE / ASK_HUMAN / DENY
- ASK_HUMAN sends a Telegram card and a web inbox item; one tap decides
- Approved purchases settle through PayPal Orders v2 (sandbox) and land in an AG Grid ledger

## Status

Planning done, implementation starting 2026-10-26. See the plan report for scope, user flows and mockups.

## License

MIT
