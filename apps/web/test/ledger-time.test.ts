import { describe, expect, it } from "vitest";
import { shortTime } from "../src/lib/format";

describe("shortTime", () => {
  it("renders a compact 24-hour stamp without zero-padded day or a year", () => {
    const out = shortTime(new Date(2026, 10, 4, 17, 42));
    expect(out).toBe("Nov 4, 17:42");
  });
  it("is empty for missing values", () => {
    expect(shortTime(null)).toBe("");
    expect(shortTime(undefined)).toBe("");
  });
});
