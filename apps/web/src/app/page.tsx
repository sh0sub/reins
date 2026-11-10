import { redirect } from "next/navigation";
import { getWorkspace } from "@reins/db";
import { getContext } from "@/server/context";

export const dynamic = "force-dynamic";

/** First visit lands on the S1 onboarding hero (value prop + setup); once PayPal is connected, on the overview. */
export default async function Home() {
  // Public demo: a judge's first view is the /try playground (the seed is already connected; /setup stays reachable)
  if (process.env.REINS_PUBLIC_DEMO === "1") redirect("/try");
  let connected = true;
  try {
    connected = Boolean((await getWorkspace((await getContext()).db)).connectedAt);
  } catch {
    // no readable workspace: fall through to the dashboard, which shows its own error state
  }
  redirect(connected ? "/overview" : "/setup");
}
