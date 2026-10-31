# Demo agent A: Claude Desktop / Claude Code

Connects an LLM agent to Reins (4 tools: `get_mandate`, `request_purchase`, `get_request_status`, `list_transactions`) and Channel3 product search.

Channel3 MCP endpoint: `https://mcp.trychannel3.com/` (source: https://channel3.mintlify.dev/docs/use-cases/mcp-agent.md). It works without a key; `X-API-Key` lifts limits.

## Claude Desktop (macOS)

1. Start Reins (`pnpm dev`) and open `/agents` in the web app. Create an agent and copy its `rk_live_...` key (shown once).
2. Open `~/Library/Application Support/Claude/claude_desktop_config.json` and merge in `mcpServers` from `agents/claude_desktop_config.json`.
3. Replace placeholders: `/ABSOLUTE/PATH/TO/reins`, `${REINS_API_URL}` (e.g. `http://localhost:3000`), `${REINS_API_KEY}`, `${CHANNEL3_API_KEY}`. Claude Desktop does not expand `${...}`. Never commit the edited file.
4. Fully quit and restart Claude Desktop. The tools menu should list 4 `reins` tools.

## Claude Code

```bash
cp .mcp.json.example .mcp.json     # .mcp.json is local; do not commit
export REINS_API_KEY=rk_live_...   # from /agents
export CHANNEL3_API_KEY=...        # optional
claude mcp list                    # reins and channel3 should be connected
```

Run `claude` from the repo root so the relative path resolves.

## Demo prompts (flow B)

**Claude Code - DevOps** (agent name in Reins):
> Our domain is expiring. Check my Reins mandate, then request a purchase to renew it at namecheap.com for $12.98 (item: "Domain renewal, 1 year", reason: "Production domain expires this week"). Report the request status and receipt.

**Research Scout**:
> Use Channel3 to find a market research report on the e-commerce industry, preferably on statista.com around $59. Pick the best match, then call Reins `request_purchase` with that merchant, price, item, and a one-line reason. Poll `get_request_status` and tell me the outcome.

## Demo agent B: DevOps cron

A non-chat agent that runs once a day. It reads its mandate (`get_mandate`), finds infra bills due within 3 days in
`agents/devops/infra-costs.json` (or `DEVOPS_COSTS_FILE`), and calls `request_purchase` for each bill at or under its auto-approve
limit (merchant rules from "Approve + always allow" count). Bigger bills are reported and left for you unless `--ask` is passed.
Client request ids are `devops-<merchant>-<item>-<YYYY-MM>`, so reruns never pay twice.

```bash
# create an agent "Claude Code - DevOps" in /agents (categories hosting, api-credits; allow render.com, vercel.com, anthropic.com)
REINS_API_URL=http://localhost:3000 REINS_API_KEY=rk_live_... pnpm agent:devops            # pay small due bills
REINS_API_URL=http://localhost:3000 REINS_API_KEY=rk_live_... pnpm agent:devops --dry-run  # report only
```

Render Cron Job (not deployed yet): command `pnpm agent:devops`, schedule `0 0 * * *` (daily 09:00 KST), env `REINS_API_URL`
(the web service URL) and `REINS_API_KEY`. The cost sheet is demo data; real Render/Vercel billing APIs are not called.
