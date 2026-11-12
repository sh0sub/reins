/**
 * /try Decision panel: after a send, rows that can still change without the visitor (a treasury payout is "paying" for
 * 20-40 s until PayPal confirms it) are re-read from GET /api/try/requests until they settle. Pure and timer-injectable
 * so the loop is unit tested without a server.
 */
import { isUnclaimedPayout } from "../../lib/format";

export const SETTLE_POLL_MS = 2_000;
export const SETTLE_TIMEOUT_MS = 180_000;

export interface SettleRow {
  request_id: string;
  status: string;
  payment?: { error?: string | null } | null;
}

/**
 * True while the row can still move on its own: approved and being paid (or still under review). `pending_human` and
 * `awaiting_buyer` wait for a person, so they count as settled here; an unclaimed payout is parked at PayPal (days).
 */
export function isSettling(row: SettleRow): boolean {
  if (row.status === "paying") return !isUnclaimedPayout(row.payment ?? null);
  return row.status === "approved" || row.status === "reviewing";
}

export interface WatchOptions<R extends SettleRow> {
  ids: string[];
  /** One call for every id still open; rows the server does not return (not this visitor's, or removed) stop being watched. */
  read: (ids: string[]) => Promise<R[]>;
  onRows: (rows: R[]) => void;
  signal: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Re-reads `ids` every `intervalMs` until none is settling, the signal aborts (unmount, a new send) or `timeoutMs` has
 * passed. A failed read (network, 429) is skipped and retried on the next tick.
 */
export async function watchUntilSettled<R extends SettleRow>(o: WatchOptions<R>): Promise<"settled" | "timeout" | "aborted"> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const interval = o.intervalMs ?? SETTLE_POLL_MS;
  const t0 = now();
  let open = [...new Set(o.ids)];
  while (open.length) {
    if (o.signal.aborted) return "aborted";
    if (now() - t0 >= (o.timeoutMs ?? SETTLE_TIMEOUT_MS)) return "timeout";
    await sleep(interval, o.signal);
    if (o.signal.aborted) return "aborted";
    let rows: R[];
    try {
      rows = await o.read(open);
    } catch {
      continue;
    }
    if (o.signal.aborted) return "aborted";
    if (rows.length) o.onRows(rows);
    const byId = new Map(rows.map((r) => [r.request_id, r]));
    open = open.filter((id) => {
      const r = byId.get(id);
      return r ? isSettling(r) : false;
    });
  }
  return "settled";
}

/** The three stages in the Decision panel while a request is in flight or its payout is settling. */
export type Stage = 0 | 1 | 2;
export const STAGES = ["Hard rules", "Claude audit", "PayPal payout"] as const;

/**
 * Which stage is current. While the POST is open the server answers in one piece, so the first second is shown as the
 * hard rules and the rest as the audit (the slow part); once the answer says "paying" the payout is the current stage.
 */
export function currentStage(phase: "sending" | "paying", sec: number): Stage {
  if (phase === "paying") return 2;
  return sec < 1 ? 0 : 1;
}
