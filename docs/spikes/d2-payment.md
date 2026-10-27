# D2 payment spike (#33, #27, #28)

Run: 2026-10-27T15:40:35.247Z (sandbox)

## OAuth

POST /v1/oauth2/token: OK

## (a) order -> approve -> capture

FAILED: a: not approved within 10 min

## (b1) store_in_vault capture (#27)

order COMPLETED, vault status VAULTED, vault id present

```json
{
  "id": "04X61877K0529583E",
  "intent": "CAPTURE",
  "status": "COMPLETED",
  "payment_source": {
    "paypal": {
      "email_address": "<redacted-email>",
      "account_id": "<redacted-id>",
      "account_status": "VERIFIED",
      "name": {
        "given_name": "John",
        "surname": "Doe"
      },
      "address": {
        "country_code": "KR"
      },
      "attributes": {
        "vault": {
          "id": "<redacted-id>",
          "status": "VAULTED",
          "customer": {
            "id": "<redacted-id>"
          },
          "links": [
            {
              "href": "https://api.sandbox.paypal.com/v3/vault/payment-tokens/8uw10238au273981g",
              "rel": "self",
              "method": "GET"
            },
            {
              "href": "https://api.sandbox.paypal.com/v3/vault/payment-tokens/8uw10238au273981g",
              "rel": "delete",
              "method": "DELETE"
            },
            {
              "href": "https://api.sandbox.paypal.com/v2/checkout/orders/04X61877K0529583E",
              "rel": "up",
              "method": "GET"
            }
          ]
        }
      }
    }
  },
  "purchase_units": [
    {
      "reference_id": "default",
      "amount": {
        "currency_code": "USD",
        "value": "0.01"
      },
      "payee": {
        "email_address": "<redacted-email>",
        "merchant_id": "9XFH3ZZEAWJQU"
      },
      "description": "Reins spike",
      "payments": {
        "captures": [
          {
            "id": "03A015968J4767410",
            "status": "COMPLETED",
            "amount": {
              "currency_code": "USD",
              "value": "0.01"
            },
            "final_capture": true,
            "seller_protection": {
              "status": "ELIGIBLE",
              "dispute_categories": [
                "ITEM_NOT_RECEIVED",
                "UNAUTHORIZED_TRANSACTION"
              ]
            },
            "seller_receivable_breakdown": {
              "gross_amount": {
                "currency_code": "USD",
                "value": "0.01"
              },
              "paypal_fee": {
                "currency_code": "USD",
                "value": "0.01"
              },
              "net_amount": {
                "currency_code": "USD",
                "value": "0.00"
              }
            },
            "links": [
              {
                "href": "https://api.sandbox.paypal.com/v2/payments/captures/03A015968J4767410",
                "rel": "self",
                "method": "GET"
              },
              {
                "href": "https://api.sandbox.paypal.com/v2/payments/captures/03A015968J4767410/refund",
                "rel": "refund",
                "method": "POST"
              },
              {
                "href": "https://api.sandbox.paypal.com/v2/checkout/orders/04X61877K0529583E",
                "rel": "up",
                "method": "GET"
              }
            ],
            "create_time": "2026-10-27T15:40:28Z",
            "update_time": "2026-10-27T15:40:28Z"
          }
        ]
      }
    }
  ],
  "payer": {
    "name": {
      "given_name": "John",
      "surname": "Doe"
    },
    "email_address": "<redacted-email>",
    "payer_id": "<redacted-id>",
    "address": {
      "country_code": "KR"
    }
  },
  "create_time": "2026-10-27T15:33:45Z",
  "update_time": "2026-10-27T15:40:28Z",
  "links": [
    {
      "href": "https://api.sandbox.paypal.com/v2/checkout/orders/04X61877K0529583E",
      "rel": "self",
      "method": "GET"
    }
  ]
}
```

## (b2) buyer-absent re-order: vault_id only (#28)

create returned COMPLETED; final COMPLETED; capture COMPLETED

```json
{
  "id": "880199579M655730R",
  "intent": "CAPTURE",
  "status": "COMPLETED",
  "payment_source": {
    "paypal": {
      "email_address": "<redacted-email>",
      "account_id": "<redacted-id>",
      "account_status": "VERIFIED",
      "name": {
        "given_name": "John",
        "surname": "Doe"
      },
      "address": {
        "country_code": "KR"
      }
    }
  },
  "purchase_units": [
    {
      "reference_id": "default",
      "amount": {
        "currency_code": "USD",
        "value": "1.23"
      },
      "payee": {
        "email_address": "<redacted-email>",
        "merchant_id": "9XFH3ZZEAWJQU"
      },
      "description": "Reins spike",
      "payments": {
        "captures": [
          {
            "id": "6U2192720H8443733",
            "status": "COMPLETED",
            "amount": {
              "currency_code": "USD",
              "value": "1.23"
            },
            "final_capture": true,
            "seller_protection": {
              "status": "ELIGIBLE",
              "dispute_categories": [
                "ITEM_NOT_RECEIVED",
                "UNAUTHORIZED_TRANSACTION"
              ]
            },
            "seller_receivable_breakdown": {
              "gross_amount": {
                "currency_code": "USD",
                "value": "1.23"
              },
              "paypal_fee": {
                "currency_code": "USD",
                "value": "0.34"
              },
              "net_amount": {
                "currency_code": "USD",
                "value": "0.89"
              }
            },
            "links": [
              {
                "href": "https://api.sandbox.paypal.com/v2/payments/captures/6U2192720H8443733",
                "rel": "self",
                "method": "GET"
              },
              {
                "href": "https://api.sandbox.paypal.com/v2/payments/captures/6U2192720H8443733/refund",
                "rel": "refund",
                "method": "POST"
              },
              {
                "href": "https://api.sandbox.paypal.com/v2/checkout/orders/880199579M655730R",
                "rel": "up",
                "method": "GET"
              }
            ],
            "create_time": "2026-10-27T15:40:31Z",
            "update_time": "2026-10-27T15:40:31Z"
          }
        ]
      }
    }
  ],
  "payer": {
    "name": {
      "given_name": "John",
      "surname": "Doe"
    },
    "email_address": "<redacted-email>",
    "payer_id": "<redacted-id>",
    "address": {
      "country_code": "KR"
    }
  },
  "create_time": "2026-10-27T15:40:30Z",
  "update_time": "2026-10-27T15:40:31Z",
  "links": [
    {
      "href": "https://api.sandbox.paypal.com/v2/checkout/orders/880199579M655730R",
      "rel": "self",
      "method": "GET"
    }
  ]
}
```

## (b2) buyer-absent re-order: vault_id + stored_credential MERCHANT/UNSCHEDULED/SUBSEQUENT (#28)

create returned COMPLETED; final COMPLETED; capture COMPLETED

```json
{
  "id": "51Y424982Y902313W",
  "intent": "CAPTURE",
  "status": "COMPLETED",
  "payment_source": {
    "paypal": {
      "email_address": "<redacted-email>",
      "account_id": "<redacted-id>",
      "account_status": "VERIFIED",
      "name": {
        "given_name": "John",
        "surname": "Doe"
      },
      "address": {
        "country_code": "KR"
      },
      "stored_credential": {
        "payment_initiator": "MERCHANT",
        "usage": "SUBSEQUENT"
      }
    }
  },
  "purchase_units": [
    {
      "reference_id": "default",
      "amount": {
        "currency_code": "USD",
        "value": "1.23"
      },
      "payee": {
        "email_address": "<redacted-email>",
        "merchant_id": "9XFH3ZZEAWJQU"
      },
      "description": "Reins spike",
      "payments": {
        "captures": [
          {
            "id": "0VE71910K8426045B",
            "status": "COMPLETED",
            "amount": {
              "currency_code": "USD",
              "value": "1.23"
            },
            "final_capture": true,
            "seller_protection": {
              "status": "ELIGIBLE",
              "dispute_categories": [
                "ITEM_NOT_RECEIVED",
                "UNAUTHORIZED_TRANSACTION"
              ]
            },
            "seller_receivable_breakdown": {
              "gross_amount": {
                "currency_code": "USD",
                "value": "1.23"
              },
              "paypal_fee": {
                "currency_code": "USD",
                "value": "0.34"
              },
              "net_amount": {
                "currency_code": "USD",
                "value": "0.89"
              }
            },
            "links": [
              {
                "href": "https://api.sandbox.paypal.com/v2/payments/captures/0VE71910K8426045B",
                "rel": "self",
                "method": "GET"
              },
              {
                "href": "https://api.sandbox.paypal.com/v2/payments/captures/0VE71910K8426045B/refund",
                "rel": "refund",
                "method": "POST"
              },
              {
                "href": "https://api.sandbox.paypal.com/v2/checkout/orders/51Y424982Y902313W",
                "rel": "up",
                "method": "GET"
              }
            ],
            "create_time": "2026-10-27T15:40:34Z",
            "update_time": "2026-10-27T15:40:34Z"
          }
        ]
      }
    }
  ],
  "payer": {
    "name": {
      "given_name": "John",
      "surname": "Doe"
    },
    "email_address": "<redacted-email>",
    "payer_id": "<redacted-id>",
    "address": {
      "country_code": "KR"
    }
  },
  "create_time": "2026-10-27T15:40:33Z",
  "update_time": "2026-10-27T15:40:34Z",
  "links": [
    {
      "href": "https://api.sandbox.paypal.com/v2/checkout/orders/51Y424982Y902313W",
      "rel": "self",
      "method": "GET"
    }
  ]
}
```

## Decision (2026-10-28 KST)

- (a) FAILED is a timing artifact only: the first approval link expired (10 min) before the buyer logged in with the Personal sandbox account. The same flow succeeded in (b1), so no separate re-run is needed.
- (b1) `store_in_vault: ON_SUCCESS` capture → `COMPLETED`, vault `status: VAULTED`, vault id returned. **#27 closed: Vault works in sandbox.**
- (b2) buyer-absent re-order with `vault_id` only → `COMPLETED`. **#28 closed: `stored_credential` is NOT required**; keep `PAYPAL_VAULT_STORED_CREDENTIAL=0` (variant with MERCHANT/UNSCHEDULED/SUBSEQUENT also `COMPLETED`, so either is acceptable).
- Sandbox app Features > "Save payment methods" toggle: not needed to check — vaulting worked with the default app settings (KR business account).
- **Automatic mode = `vaulted`.** Set `PAYPAL_PAYMENT_MODE=vaulted` in `.env` (supervised stays the fallback for ASK_HUMAN; treasury for payouts). Risk R1 (#43) is closed.
- Sandbox fee note: a $0.01 capture nets $0.00 after PayPal fee; demo amounts ($12.98 / $59) are unaffected.
