/** "12.98" | 12.98 -> 1298. Rejects negatives, NaN and more than 2 decimals. */
export function toCents(value: string | number): number {
  const s = typeof value === "number" ? value.toFixed(2) : value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid amount: ${value}`);
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** 1298 -> "12.98" (PayPal amount.value format). */
export function centsToValue(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** 1298 -> "$12.98" */
export function formatUsd(cents: number): string {
  return `$${centsToValue(cents)}`;
}
