import { redirect } from "next/navigation";

/** Shareable S6 link: /ledger/R-0143 (or an internal req_ id) opens the ledger with that request's drawer. */
export default async function LedgerDeepLink({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/ledger?r=${encodeURIComponent(decodeURIComponent(id))}&drawer=1`);
}
