import type { Metadata } from "next";
import { CheckoutResult } from "../CheckoutResult";

export const metadata: Metadata = { title: "Checkout canceled" };

/** H5 cancel_url of supervised orders: POST /api/pay/cancel moves the request to failed (no longer committed). */
export default function Page() {
  return <CheckoutResult kind="cancel" />;
}
