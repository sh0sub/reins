import type { Metadata } from "next";
import { CheckoutResult } from "../CheckoutResult";

export const metadata: Metadata = { title: "PayPal checkout" };

/** H5 return_url of supervised orders: POST /api/pay/return captures once (races safely with the webhook). */
export default function Page() {
  return <CheckoutResult kind="return" />;
}
