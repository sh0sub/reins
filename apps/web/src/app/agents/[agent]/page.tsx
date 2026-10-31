import { redirect } from "next/navigation";

/** Shareable S2 link: /agents/research-scout (name slug or agent id) opens the Agents screen on that agent. */
export default async function AgentDeepLink({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = await params;
  redirect(`/agents?agent=${encodeURIComponent(decodeURIComponent(agent))}`);
}
