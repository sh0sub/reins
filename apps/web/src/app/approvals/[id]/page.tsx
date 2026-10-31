import { redirect } from "next/navigation";

/** Shareable S5 link: /approvals/R-0142 (or an internal req_ id) opens the inbox on that request. */
export default async function ApprovalDeepLink({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/inbox?r=${encodeURIComponent(decodeURIComponent(id))}`);
}
