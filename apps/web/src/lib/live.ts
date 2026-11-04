"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * One shared /api/events connection per tab (nav badge, inbox and ledger all listen to it).
 * - named `ping` events every heartbeat_ms; if nothing arrives for 2.5x that, the socket is treated as dead,
 *   closed and reopened with backoff (1s, 2s, 4s … 15s)
 * - after every (re)connect listeners get a "resync" so they refetch whatever was missed while offline
 * - the connection closes when the last listener unsubscribes
 */
export type LiveStatus = "connecting" | "live" | "reconnecting" | "offline";
export interface LiveEvent {
  type: "request.created" | "request.updated" | "resync";
  request?: { request_id: string; display_id: string; status: string; [k: string]: unknown };
}
type Listener = (e: LiveEvent) => void;

export interface LiveOptions {
  url?: string;
  /** Injected in tests. */
  createSource?: (url: string) => EventSourceLike;
  now?: () => number;
}
export interface EventSourceLike {
  addEventListener(type: string, fn: (e: MessageEvent) => void): void;
  close(): void;
  onerror: ((e: Event) => void) | null;
  onopen: ((e: Event) => void) | null;
}

export const CONNECT_TIMEOUT_MS = 3_000;

export class LiveConnection {
  private source: EventSourceLike | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<() => void>();
  private heartbeatMs = 15_000;
  private lastSeen = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  status: LiveStatus = "offline";

  constructor(private readonly opts: LiveOptions = {}) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private setStatus(s: LiveStatus) {
    if (s === this.status) return;
    this.status = s;
    for (const fn of this.statusListeners) fn();
  }

  private emit(e: LiveEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* one broken listener must not stop the others */
      }
    }
  }

  private open() {
    const create = this.opts.createSource ?? ((u: string) => new EventSource(u) as unknown as EventSourceLike);
    if (!this.opts.createSource && typeof EventSource === "undefined") return;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const es = create(this.opts.url ?? "/api/events");
    this.source = es;
    this.lastSeen = this.now();
    const seen = () => {
      this.lastSeen = this.now();
    };
    es.addEventListener("ready", (e) => {
      seen();
      try {
        const hb = (JSON.parse(e.data) as { heartbeat_ms?: number }).heartbeat_ms;
        if (hb && hb > 0) this.heartbeatMs = hb;
      } catch {
        /* keep default */
      }
      this.attempt = 0;
      this.setStatus("live");
      this.emit({ type: "resync" });
    });
    es.addEventListener("ping", seen);
    for (const type of ["request.created", "request.updated"] as const) {
      es.addEventListener(type, (e) => {
        seen();
        let request: LiveEvent["request"];
        try {
          request = JSON.parse(e.data);
        } catch {
          request = undefined;
        }
        this.emit({ type, request });
      });
    }
    // an open stream is already "live"; the `ready` event only adds the heartbeat length and the resync
    es.onopen = () => {
      if (this.status === "connecting" || this.status === "reconnecting") this.setStatus("live");
    };
    es.onerror = () => this.restart();
    // never sit on "Connecting…": if neither open nor ready arrives within 3 s, show Offline while retries continue
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.source === es && this.status !== "live") this.setStatus("offline");
    }, CONNECT_TIMEOUT_MS);
    this.watchdog ??= setInterval(() => {
      if (this.source && this.now() - this.lastSeen > this.heartbeatMs * 2.5) this.restart();
    }, 5_000);
  }

  /** Close and reopen with exponential backoff (EventSource's own retry gives up after a non-200). */
  restart() {
    this.source?.close();
    this.source = null;
    if (!this.listeners.size) return;
    if (this.retryTimer) return;
    this.attempt += 1;
    this.setStatus(this.attempt > 4 ? "offline" : "reconnecting");
    const delay = Math.min(1000 * 2 ** (this.attempt - 1), 15_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.listeners.size) this.open();
    }, delay);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    if (!this.source && !this.retryTimer) this.open();
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) this.close();
    };
  }

  onStatus(fn: () => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  close() {
    this.source?.close();
    this.source = null;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.watchdog = null;
    this.retryTimer = null;
    this.attempt = 0;
    this.setStatus("offline");
  }
}

let shared: LiveConnection | null = null;
export function liveConnection(): LiveConnection {
  shared ??= new LiveConnection();
  return shared;
}

/** Calls `onEvent` for every request change and after every reconnect (resync). */
export function useLive(onEvent: (e: LiveEvent) => void): void {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => liveConnection().subscribe((e) => ref.current(e)), []);
}

export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(
    (cb) => liveConnection().onStatus(cb),
    () => liveConnection().status,
    () => "connecting" as LiveStatus,
  );
}
