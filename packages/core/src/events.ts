import type { RequestView } from "./views.ts";

export type ReinsEvent =
  | { type: "request.created"; request: RequestView }
  | { type: "request.updated"; request: RequestView };

type Listener = (e: ReinsEvent) => void;

/** In-process pub/sub feeding SSE (/api/events) and notifiers. */
export class ReinsEvents {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: ReinsEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a broken subscriber must not break the payment flow */
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}

/** Out-of-band channel for human approvals (Telegram). Failures are swallowed by the caller. */
export interface Notifier {
  readonly name: string;
  pendingHuman(view: RequestView): Promise<void>;
  resolved(view: RequestView): Promise<void>;
  /** Optional: the card changed without a decision (S2 question asked or answered). */
  updated?(view: RequestView): Promise<void>;
}
