import type { Metadata } from "next";
import { PLAYGROUND_AGENT, PLAYGROUND_MANDATE, playgroundEnabled } from "@reins/core";
import TryClient from "./TryClient";

export const metadata: Metadata = { title: "Try an agent" };
export const dynamic = "force-dynamic";

/** Server-rendered shell: the mandate and the presets are on screen before any script runs. */
export default function TryPage() {
  return <TryClient enabled={playgroundEnabled()} agent={PLAYGROUND_AGENT} mandate={PLAYGROUND_MANDATE} />;
}
