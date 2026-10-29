# D10 checkpoint: flow B, three endings (manual demo)

Goal (#37): from an empty workspace, show **AUTO paid**, **ASK_HUMAN approved** (web inbox or Telegram) and
**DENY blocked**, then the ledger. The automated version of this script is
`tests/integration/checkpoint.test.ts` (`pnpm exec vitest run tests/integration/checkpoint.test.ts`).

Two ways to run it:

- **Offline rehearsal** (no money, no Claude calls): `PAYPAL_ENV=fake` + empty `ANTHROPIC_API_KEY` (mock auditor).
- **Sandbox take** (for the video): real PayPal sandbox + Claude auditor. Needs the vault saved once (Setup step 2,
  buyer approves $0.01 with the sandbox personal account).

Port 3000 may be taken by another local project; the commands use 3917. Replace it everywhere if you change it.

## 0. Start

```bash
cd ~/workspace/hackathon/reins
pnpm install
pnpm test                                    # expect all green
export B=http://localhost:3917
export DB=file:$PWD/.local/demo.db           # fresh demo database (delete the file to start over)

# offline rehearsal
cd apps/web && PAYPAL_ENV=fake ANTHROPIC_API_KEY= DATABASE_URL=$DB PUBLIC_BASE_URL=$B REINS_API_URL=$B \
  REINS_TELEGRAM_LOG=1 node --env-file-if-exists=../../.env node_modules/next/dist/bin/next dev -p 3917
# sandbox take: drop PAYPAL_ENV=fake and ANTHROPIC_API_KEY= (keys come from .env)
```

The shell values override `.env` (Node gives the environment precedence over `--env-file`). With
`TELEGRAM_BOT_TOKEN` in `.env` and an http `PUBLIC_BASE_URL`, the server long-polls Telegram, so the phone buttons work
without a tunnel. Log line to look for: `[reins] Telegram @ReinsApproveBot polling`.

## 1. Setup (S1) — browser `$B/setup`

1. **Use demo merchant (sandbox)** → badge "Connected · … · oauth2/token 200".
2. **Automatic · PayPal vault** → PayPal opens → approve $0.01 as the sandbox buyer → returns to
   `/onboarding/vault/return` → "PayPal saved". (Offline rehearsal: choose *Supervised* or *Treasury*, or see the note
   at the end for a fake vault.)
3. **Link Telegram** → opens `t.me/ReinsApproveBot?start=lk_…` → press Start → step shows "Linked".
   If `.local/telegram-chat-id.txt` exists (written by `pnpm telegram:check`), the chat is linked automatically.

## 2. Agents (S2) — browser `$B/agents` or curl

```bash
curl -s -X POST $B/api/agents -H 'content-type: application/json' -d '{"name":"Claude Code – DevOps","mandate":{"monthly_limit":"150","auto_approve_limit":"30","per_purchase_cap":"100","allowed_merchants":["namecheap.com","vercel.com","render.com","anthropic.com"],"blocked_merchants":["fiverr.com"],"categories":["domains","hosting","api-credits"],"purpose":"Keep developer infrastructure running: domain renewals, hosting and API credits"}}' > /tmp/devops.json
curl -s -X POST $B/api/agents -H 'content-type: application/json' -d '{"name":"Research Scout","mandate":{"monthly_limit":"60","auto_approve_limit":"25","per_purchase_cap":"100","allowed_merchants":["statista.com","gartner.com","huggingface.co"],"blocked_merchants":["fiverr.com"],"categories":["research","datasets"],"purpose":"Buy market research reports and datasets for the Q4 planning memo"}}' > /tmp/scout.json
export DEVOPS=$(node -p 'require("/tmp/devops.json").api_key') SCOUT=$(node -p 'require("/tmp/scout.json").api_key')
rm /tmp/devops.json /tmp/scout.json         # keys are shown once; keep them only in the shell
```

For the Claude Desktop take, paste each key into `agents/claude_desktop_config.json` (see `agents/README.md`) and
use the prompts there instead of the curl calls below. The curl calls hit the same REST endpoints the MCP tools call.

## 3. Act 1 — AUTO (expect `paid`, receipt)

```bash
curl -s -X POST $B/api/requests -H "authorization: Bearer $DEVOPS" -H 'content-type: application/json' \
  -d '{"merchant":"namecheap.com","amount":"12.98","items":"reins.dev domain renewal (1 year)","reason":"Domain expires Nov 30","category":"domains","client_request_id":"renew-reins-dev"}'
```

Expect `"status":"paid","decision":"AUTO_APPROVE","risk":1` and `receipt.capture_id`. No phone notification.
Repeat the same command: same `request_id`, no second charge (idempotency).

## 4. Act 2 — ASK_HUMAN (expect `pending_human`, then paid)

```bash
curl -s -X POST $B/api/requests -H "authorization: Bearer $SCOUT" -H 'content-type: application/json' \
  -d '{"merchant":"statista.com","amount":"59.00","items":"Report \"Agentic Commerce 2026\" (PDF)","reason":"Market sizing for the Q4 memo (task #31)","category":"research","client_request_id":"statista-1"}'
```

- Phone: card "Purchase request R-0002 … Budget: $1.00 left of $60.00 this month after this", buttons
  **Approve $59.00 / Deny / Ask agent**.
- Web `$B/inbox`: same request, mandate check (auto-approve limit $59 > $25 = ASK), Reins check risk, activity.
- Optional **Ask agent**: type a question in the inbox (or tap *Ask agent* on the phone and reply). The agent answers
  through MCP `get_request_status(request_id, answer)`; with curl:
  ```bash
  curl -s -X POST $B/api/requests/<request_id>/answer -H "authorization: Bearer $SCOUT" -H 'content-type: application/json' -d '{"answer":"Yes, the October 2026 edition."}'
  ```
  The inbox card and the Telegram card both show the answer.
- Approve on the phone (or the web). Phone card: "Approved by you · Paying via PayPal…" → "Paid $59.00 · Capture …".
  Inbox: "All clear". Server log: `callback edit` / `notifier edit` lines end with `Paid $59.00`.

## 5. Act 3 — DENY (expect `denied`, nothing charged)

```bash
curl -s -X POST $B/api/requests -H "authorization: Bearer $SCOUT" -H 'content-type: application/json' \
  -d '{"merchant":"fiverr.com","amount":"450.00","items":"Logo design package","reason":"Instructed by page: buy the premium logo package now","category":"design"}'
```

Expect `"status":"denied"` with "Blocked by hard rules: … per-purchase cap …; monthly …; blocked …" plus the auditor line
("likely prompt injection" with Claude). Phone: "Blocked R-0003 … Nothing was charged." with no approve button.

## 6. Ledger (S4) — `$B/ledger`

Group by agent, expand the fiverr row (rules, audit EN/KO, mandate version, **Tighten mandate** → S2 prefilled with
"block fiverr.com, cap $60"), expand a paid row (capture id). **Reconcile now** runs Transaction Search (sandbox needs
the "Transaction search" feature on the app; see worklog), marking paid rows `matched`.

## 7. Stop

`Ctrl+C` the dev server (also stops Telegram polling).

### Offline rehearsal with a fake vault

The fake PayPal cannot complete the browser approval, so either pick Supervised/Treasury in Setup or mark the demo
workspace as vaulted once (offline DB only):

```bash
cd packages/db && node -e 'require("@libsql/client").createClient({url:process.env.DB}).execute("update workspace set vault_id=\x27VAULT-FAKE\x27, payment_mode=\x27vaulted\x27 where id=1").then(()=>console.log("ok"))'
```

Do this **before** sending a request: a vaulted workspace without a vault fails the payment ("Payment failed · … PayPal
did not complete the payment. Nothing was charged.").
