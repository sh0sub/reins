/**
 * Keep-warm for the hosted MCP service (free Render instances sleep after 15 min idle): when REINS_KEEPWARM_URL is set,
 * GET it every 10 minutes from the web process. Unset = no timer at all. Failures are swallowed with one log line (the
 * URL is logged, nothing else). Started once per process from createContextFromEnv, next to the expiry sweep.
 */
type Env = Record<string, string | undefined>;

export const KEEPWARM_INTERVAL_MS = 10 * 60_000;

export interface KeepWarmDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  log?: (msg: string) => void;
}

/** Returns the tick function when enabled (tests call it directly), null when REINS_KEEPWARM_URL is unset or not http(s). */
export function startKeepWarm(env: Env, deps: KeepWarmDeps = {}): (() => Promise<void>) | null {
  const url = env.REINS_KEEPWARM_URL?.trim();
  if (!url || !/^https?:\/\//.test(url)) return null;
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const tick = async () => {
    try {
      const res = await doFetch(url, { method: "GET", signal: AbortSignal.timeout(30_000) });
      await res.body?.cancel().catch(() => undefined);
    } catch (err) {
      log(`[reins] keep-warm GET ${url} failed: ${err instanceof Error ? err.message : "error"}`);
    }
  };
  const timer = (deps.setInterval ?? setInterval)(() => void tick(), KEEPWARM_INTERVAL_MS);
  timer.unref?.();
  return tick;
}
