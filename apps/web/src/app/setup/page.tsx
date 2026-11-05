import { getContext } from "@/server/context";
import { workspaceView } from "@/server/workspace";
import SetupClient from "./SetupClient";

export const dynamic = "force-dynamic";

/** Server-renders the workspace so /setup never paints as an empty skeleton. Falls back to the client fetch on any error. */
export default async function SetupPage() {
  let initial = null;
  // with an admin token set the API is guarded, so the page must not read the workspace around it
  if (!process.env.REINS_ADMIN_TOKEN) {
    try {
      initial = await workspaceView(await getContext());
    } catch {
      /* the client fetch shows its own error state */
    }
  }
  return <SetupClient initial={initial} />;
}
