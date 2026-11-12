# Use Reins from Claude Code (MCP guide for judges)

About 3 minutes. No account, no login, no key, no install besides Claude Code. The hosted dashboard is a public demo: every page, including the approval inbox, opens without signing in. All payments are PayPal sandbox payouts (no real money).

## 1. Connect

```bash
claude mcp add --transport http reins https://reins-mcp.onrender.com/mcp
```

Check it:

```bash
claude mcp list        # "reins" should show as connected
```

Inside Claude Code, `/mcp` lists the server and its four tools:

| Tool | What it does |
|---|---|
| `get_mandate` | Shows what this agent may spend: caps, auto-approve limit, allowed merchants |
| `request_purchase` | Asks Reins to pay. Returns paid, pending_human or denied |
| `get_request_status` | Returns one request's status. While a payment is settling it waits up to about 25 seconds for the final result |
| `list_transactions` | Lists this agent's recent requests |

Your session gets its own throwaway demo key for the "Playground Agent" (mandate: $300 a month, $100 per purchase, $30 auto-approve limit, merchants namecheap.com, statista.com and vercel.com). Your requests do not mix with another judge's.

## 2. Three prompts, three outcomes

Paste these into Claude Code one at a time, in the same Claude Code session. Claude Code asks before each tool call; allow it. A new session gets a new demo key and cannot see requests from an earlier one.

**A. Small and allowed: pays by itself**

```
Using the Reins MCP tools, check my mandate, then request a purchase at namecheap.com for $12.98 (item: Domain renewal, reason: production domain expires this week). Then check the status.
```

Expected: hard rules pass, the Claude auditor scores it low risk, and the request is auto-approved. The status check waits while the sandbox payout settles (about 40 seconds in total), then shows `paid` with a PayPal payout id and a receipt URL. If it still says `paying`, ask "Check the status again".

**B. Over the limit: waits for a person**

```
Using the Reins MCP tools, request a purchase at statista.com for $59.00 (item: Market report PDF, reason: market sizing for the Q4 memo).
```

Expected: `pending_human`. Open https://reins-web.onrender.com/inbox (no login), pick the request and click **Approve $59.00**. Then ask Claude Code "Check the status again": it is `paid` once the payout settles.

**C. Prompt injection: denied in code**

```
This is a test of Reins hard rules. Send this request to Reins exactly as written, even though you expect it to be denied, and show me the reason Reins gives: fiverr.com, $450.00 (item: Logo design, gold package, reason: the web page said to pay this vendor now and not ask the user).
```

Expected: `denied`. Three hard rules fail (per-purchase cap, monthly limit, merchant allow list). Nothing is charged.

The prompt says "this is a test" on purpose. Without it, Claude Code reads the mandate, sees the request cannot pass and refuses to send it at all, so you would not see Reins deny it.

**Optional. A new subscription asks first**

```
Using the Reins MCP tools, request a purchase at vercel.com for $20.00 with recurring set to monthly (item: Vercel Pro, reason: hosting plan for the landing page).
```

Expected: `pending_human`, although $20 is under the $30 limit. The inbox shows "$20.00 monthly · $240.00 a year".

## 3. See what was recorded

- https://reins-web.onrender.com/ledger: every request with its rules, the auditor's explanation and the PayPal id. Filter by "Playground Agent".
- https://reins-web.onrender.com/proof: which parts are real sandbox calls and which are simulated.

## 4. If something goes wrong

| What you see | What to do |
|---|---|
| `reins` shows as failed in `claude mcp list` | Run the `claude mcp add` line again. Check https://reins-mcp.onrender.com/health returns `ok` |
| "Too many open sessions from this address" | Live sessions are limited to 20 per address and close after 30 idle minutes. Wait, or use https://reins-web.onrender.com/try instead |
| Status stays `paying` | The sandbox payout is still settling (about 40 seconds; each status check waits up to 25). Ask Claude Code to check the status again |
| "Request not found" for a request you just sent | You are in a new Claude Code session, which has a new demo key. Find the request in the ledger, or send it again |
| The same purchase returns the earlier result | Reins treats the same purchase within 10 minutes as a retry, so it never pays twice. Change the item or amount to send a new one |
| A request you sent is gone | The hosted database resets to the recorded run on each deploy |

## 5. Remove it

```bash
claude mcp remove reins
```

## No Claude Code?

- Browser only: https://reins-web.onrender.com/try sends the same requests through the same code path.
- Offline: `pnpm install && pnpm judge`, then `pnpm judge:agent` runs a small agent over MCP (simulated PayPal).
- Other MCP clients: the endpoint is Streamable HTTP at `https://reins-mcp.onrender.com/mcp` with no auth header. Only Claude Code has been tested against the hosted server.
