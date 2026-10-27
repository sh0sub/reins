import { describe, expect, it } from "vitest";
import { redact } from "./lib.ts";

describe("spike report redaction", () => {
  it("removes emails, vault/customer ids and tokens but keeps statuses", () => {
    const out = JSON.stringify(redact({ status: "COMPLETED", payment_source: { paypal: { email_address: "x@y.com", account_id: "ABC", attributes: { vault: { id: "nkq2y9g", status: "VAULTED", customer: { id: "C1" } } } } }, access_token: "A21" }));
    for (const s of ["x@y.com", "nkq2y9g", "C1", "A21", "ABC"]) expect(out).not.toContain(s);
    expect(out).toContain("VAULTED");
    expect(out).toContain("COMPLETED");
  });
});
