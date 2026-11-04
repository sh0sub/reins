import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_TIMEOUT_MS, LiveConnection, type EventSourceLike } from "../src/lib/live";

function fakeSource() {
  const handlers = new Map<string, (e: MessageEvent) => void>();
  const es: EventSourceLike = { addEventListener: (t, fn) => void handlers.set(t, fn), close: () => undefined, onerror: null, onopen: null };
  return { es, handlers };
}

describe("LiveConnection status fallback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("goes Offline after 3 s when the stream never opens", () => {
    const { es } = fakeSource();
    const c = new LiveConnection({ createSource: () => es });
    const off = c.subscribe(() => undefined);
    expect(c.status).toBe("connecting");
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS + 1);
    expect(c.status).toBe("offline");
    off();
  });

  it("goes Live as soon as the stream opens and stays Live past the timeout", () => {
    const { es } = fakeSource();
    const c = new LiveConnection({ createSource: () => es });
    const off = c.subscribe(() => undefined);
    es.onopen?.(new Event("open"));
    expect(c.status).toBe("live");
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS + 1);
    expect(c.status).toBe("live");
    off();
  });
});
