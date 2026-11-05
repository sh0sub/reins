import type { Metadata } from "next";
import { resolve } from "node:path";
import { PLAYGROUND_AGENT, PLAYGROUND_MANDATE, judgeMode, playgroundEnabled, runAttackSuite, type AttackSuiteResult } from "@reins/core";
import TryClient from "./TryClient";
import { AttackSuite } from "./AttackSuite";
import { ConnectAgent } from "@/components/ConnectAgent";

export const metadata: Metadata = { title: "Try an agent" };
export const dynamic = "force-dynamic";

/** The suite is deterministic and runs on its own in-memory database, so it is computed once per server process. */
const g = globalThis as unknown as { __reinsAttacks?: Promise<AttackSuiteResult> };
const attackSuite = () => (g.__reinsAttacks ??= runAttackSuite({ migrationsFolder: process.env.REINS_MIGRATIONS_DIR ?? resolve(process.cwd(), "../../packages/db/drizzle") }));

/** Server-rendered shell: the mandate and the presets are on screen before any script runs. */
export default async function TryPage() {
  const suite = await attackSuite().catch(() => null);
  return (
    <>
      <TryClient enabled={playgroundEnabled()} judge={judgeMode()} agent={PLAYGROUND_AGENT} mandate={PLAYGROUND_MANDATE} />
      <div className="stack-l try-extra">
        {playgroundEnabled() && <ConnectAgent />}
        {suite && <AttackSuite suite={suite} />}
      </div>
    </>
  );
}
