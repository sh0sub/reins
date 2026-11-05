import { parsePeriod, getOverview, playgroundEnabled, type Overview } from "@reins/core";
import { getContext } from "@/server/context";
import OverviewClient from "./OverviewClient";

export const dynamic = "force-dynamic";

/** Server-renders the numbers so the first paint already shows data. Falls back to the client fetch on any error. */
export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  let initial: Overview | null = null;
  // with an admin token set the API is guarded, so the page must not read the ledger around it
  if (!process.env.REINS_ADMIN_TOKEN) {
    try {
      initial = await getOverview(await getContext(), parsePeriod((await searchParams).period));
    } catch {
      /* the client fetch shows its own error state */
    }
  }
  return <OverviewClient initial={initial} tryEnabled={playgroundEnabled()} />;
}
