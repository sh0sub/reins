"use client";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    // every write is JSON (the server refuses other content types on POST as a CSRF guard)
    headers: init.body === undefined && (init.method ?? "GET") === "GET" ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? ((init.method ?? "GET") === "GET" ? undefined : "{}") : JSON.stringify(init.body),
    credentials: "same-origin",
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, String(json.error ?? "error"), String(json.message ?? "Request failed"));
  return json as T;
}

/** Subscribes to the shared /api/events connection (see lib/live.ts) and calls back on every change. */
export { liveConnection } from "./live";
