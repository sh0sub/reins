# D3 Payouts + webhooks spike (#34)

Run: 2026-10-27T15:55:22.327Z (sandbox)

## 1. Payout business -> personal

```json
{
  "batch_header": {
    "payout_batch_id": "UALE8USQRMHYW",
    "batch_status": "PENDING",
    "time_created": "2026-10-27T15:55:08Z",
    "sender_batch_header": {
      "sender_batch_id": "spike-1793116506673",
      "email_subject": "<redacted-email>"
    },
    "funding_source": "BALANCE",
    "amount": {
      "currency": "USD",
      "value": "1.00"
    }
  },
  "items": [
    {
      "payout_item_id": "MXM9THB3Z7JRU",
      "transaction_status": "PENDING",
      "payout_batch_id": "UALE8USQRMHYW",
      "payout_item": {
        "recipient_type": "EMAIL",
        "amount": {
          "currency": "USD",
          "value": "1.00"
        },
        "note": "Reins spike",
        "receiver": "<redacted-email>",
        "sender_item_id": "spike-1",
        "recipient_wallet": "PAYPAL",
        "purpose": "GOODS"
      },
      "links": [
        {
          "href": "https://api.sandbox.paypal.com/v1/payments/payouts-item/MXM9THB3Z7JRU",
          "rel": "item",
          "method": "GET",
          "encType": "application/json"
        }
      ]
    }
  ],
  "links": [
    {
      "href": "https://api.sandbox.paypal.com/v1/payments/payouts/UALE8USQRMHYW?page_size=1000&page=1",
      "rel": "self",
      "method": "GET",
      "encType": "application/json"
    }
  ]
}
```

## 2. Webhook

URL https://push-deck-values-beth.trycloudflare.com/api/webhooks/paypal
webhook id: set PAYPAL_WEBHOOK_ID in .env (obtained)
Subscribed: CHECKOUT.ORDER.APPROVED, PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.DENIED, PAYMENT.CAPTURE.DECLINED, PAYMENT.PAYOUTS-ITEM.SUCCEEDED, PAYMENT.PAYOUTS-ITEM.FAILED, PAYMENT.PAYOUTS-ITEM.BLOCKED, PAYMENT.PAYOUTS-ITEM.RETURNED, PAYMENT.PAYOUTS-ITEM.DENIED, PAYMENT.PAYOUTS-ITEM.UNCLAIMED

## 3. simulate-event

| event | result |
|---|---|
| CHECKOUT.ORDER.APPROVED | sent (WH-COC11055RA711503B-4YM959094A144403T) |
| PAYMENT.CAPTURE.COMPLETED | sent (WH-7Y7254563A4550640-11V2185806837105M) |
| PAYMENT.CAPTURE.DENIED | sent (WH-8Y6524781B2662740-6BA13970S75831204) |
| PAYMENT.CAPTURE.DECLINED | FAILED HTTP 400 Not a valid Resource Type (debug_id f1329415fd107) PayPal 400 Not a valid Resource Type: Invalid data provided |
| PAYMENT.PAYOUTS-ITEM.SUCCEEDED | sent (WH-68L35871MU875914X-8DM79009TB591331B) |
| PAYMENT.PAYOUTS-ITEM.FAILED | sent (WH-68L35871MU875914X-8DM79009TB591331B) |
| PAYMENT.PAYOUTS-ITEM.BLOCKED | sent (WH-68L35871MU875914X-8DM79009TB591331B) |
| PAYMENT.PAYOUTS-ITEM.RETURNED | sent (WH-68L35871MU875914X-8DM79009TB591331B) |
| PAYMENT.PAYOUTS-ITEM.DENIED | sent (WH-68L35871MU875914X-8DM79009TB591331B) |
| PAYMENT.PAYOUTS-ITEM.UNCLAIMED | sent (WH-68L35871MU875914X-8DM79009TB591331B) |

Check the web app log for verify-webhook-signature results. Note: simulated events may fail signature verification by design (미확인); confirm with a real sandbox order.

## Decision (2026-10-28 KST, second run)

- Payout business -> personal $1.00: batch `SUCCESS`, item `SUCCESS` (checked via GET /v1/payments/payouts/{batch_id}). Treasury mode works in sandbox.
- Webhook registered once; URL patched via `PATCH /v1/notifications/webhooks/{id}` when the quick tunnel hostname changed. **Final event list:** the 10 subscribed types above minus `PAYMENT.CAPTURE.DECLINED` for the simulator only (PayPal's simulate-event rejects it with "Not a valid Resource Type"; keep it subscribed for real deliveries).
- **verify-webhook-signature on real deliveries: SUCCESS.** Simulated events (`PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`) and the real `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` from the payout above were all stored in `webhook_events` only after verification succeeded. A forged request (dummy headers) returns 401.
- **Idempotency: confirmed.** The real payout event was resent twice (`POST /v1/notifications/webhooks-events/{id}/resend`, HTTP 202 both times) and appears once in `webhook_events`.
- Outcomes `unknown_order` / `unknown_batch` are expected: the simulated resources and the spike payout are not Reins requests. Flow B webhooks will match by order id / payout batch id.
- Root cause of the first run's 0 rows: `apps/web` (Next.js) did not load the repo-root `.env`, so `PAYPAL_WEBHOOK_ID` was missing and the handler returned 503. Fixed by running Next through `node --env-file-if-exists=../../.env` in `apps/web/package.json` scripts.
- `PUBLIC_BASE_URL` must be the public https origin whenever PayPal needs to call back (webhooks, return URLs). Quick tunnels change hostname on every restart; Render (#38) gives a stable one.
