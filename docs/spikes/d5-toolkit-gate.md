# D5 Toolkit gate spike (cycle 4, K1)

Question: does `reinsGate` work with the real `@paypal/agent-toolkit`, not only a fake one?

Run: 2026-11-04, PayPal sandbox, `@paypal/agent-toolkit` 1.11.0 (installed with npm into a scratch directory), via
`pnpm exec tsx --env-file=.env scripts/demo/toolkit-gate-run.mjs --work <scratch dir>`. Scratch SQLite DB, supervised
mode, deterministic mock auditor (no Claude call in this spike; the Claude audit is covered by docs/spikes/claude-audit.md).
The script drives the Toolkit's own `PayPalMCPToolkit.getPaypalAPIService().run(method, args)`, the same entry point the
Toolkit's agent integrations use.

## Result

| Step | Outcome |
|---|---|
| Approved run: $12.00 at kaggle.com, inside the mandate | Reins approved it; the real Toolkit `create_order` created a sandbox order (`PAYER_ACTION_REQUIRED`); Reins moved the request to `awaiting_buyer` and stored the order id and approval link |
| Denied run: $450 at fiverr.com, reason injected by a web page | Reins denied it (cap, monthly cap, blocked merchant, injection); Toolkit calls in this run: **0** |
| Capture through the Toolkit (`pay_order`) on the approved order | **Not completed.** The call reached the real Toolkit and PayPal answered HTTP 422, "Payer has not yet approved the Order for payment". A sandbox capture needs the buyer to sign in on the PayPal sandbox approval page, and the run has no buyer password. The error is surfaced as an error, not as a success |

Total Toolkit calls in the run: 2 (`create_order`, `pay_order`). The denied request never reached it.

## Output (secrets are never printed; scratch path shortened)

```
@paypal/agent-toolkit 1.11.0, PayPal sandbox, order tools: create_order, get_order, pay_order

Run 1: approved (kaggle.com, $12.00, inside the mandate and under the auto-approve limit)
    -> Toolkit create_order({"currencyCode":"USD","items":[{"name":"R-0001 kaggle.com: Retail dataset","quantity":1,"itemCost":12,"itemTotal":12}],"returnUrl":"http://localhost:3000/pay/return?request=req_...","cancelUrl":"http://localhost:3000/pay/cancel?request=req_..."})
    <- create_order: PAYER_ACTION_REQUIRED 3KE34883913235318
  Reins: awaiting_buyer (Fits the mandate purpose and is within limits.); Toolkit calls in this run: 1
  PayPal order 3KE34883913235318 (ledger payment: supervised, awaiting_buyer)

Run 2: denied (fiverr.com, $450, instructed by a web page)
  Reins: denied (Blocked by hard rules: $450.00 exceeds per-purchase cap $100.00; Spent $12.00 + this $450.00 = $462.00 > $60.00 monthly cap; fiverr.com is blocked. The request reason looks like a prompt injection from external content, not the user's intent.); Toolkit calls in this run: 0

Capture through the Toolkit (the buyer has not approved on the sandbox login page yet)
    -> Toolkit pay_order({"id":"3KE34883913235318"})
    <- pay_order: error (HTTP 422)
    <- capture refused: Agent Toolkit error PAYPAL_API_HTTP_ERROR: The requested action could not be performed, semantically incorrect, or failed business validation.: Payer has not yet approved the Order for payment. Please redirect the payer to the 'rel':'approve'

Toolkit calls in total: 2 (create_order, pay_order)
```

## What the real run found (all fixed in `packages/core/src/pay/toolkit.ts`, with tests)

The adapter was written from the Toolkit's documentation. Running the real package showed four wrong assumptions:

1. `create_order` validates items with zod: `quantity` and `itemCost` must be numbers (the adapter sent strings) and `itemTotal` is required.
2. The capture tool is named `pay_order` in 1.11.0 ("Process payment for an authorized order"), not `capture_order`.
3. `PayPalAPI.run()` never throws. Validation failures come back as `{"error": {...}}` and PayPal HTTP errors as `{"ok": false, "status": 422, ...}`. Without a check, a refused capture looked like a success; both shapes now raise.
4. A successful capture is wrapped as `{"status": "success", "response": <order>}`; the adapter unwraps it. This shape comes from the Toolkit source; it was not observed live because no capture succeeded.

## Limits

- Only approval-link (supervised) orders: the Toolkit's `create_order` has no `vault_id` option.
- The sandbox capture was not completed (needs a buyer login); a completed capture through the Toolkit is untested live.
- The mock auditor was used, so this spike says nothing about audit quality.
