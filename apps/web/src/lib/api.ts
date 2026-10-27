"use client";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, String(json.error ?? "error"), String(json.message ?? "Request failed"));
  return json as T;
}

/** Subscribes to /api/events (SSE) and calls back on every request change. */
export function subscribeEvents(onChange: () => void): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const es = new EventSource("/api/events");
  es.addEventListener("request.created", onChange);
  es.addEventListener("request.updated", onChange);
  return () => es.close();
}
