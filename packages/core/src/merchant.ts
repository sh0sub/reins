/** "https://www.Namecheap.com/renew" -> "namecheap.com" */
export function normalizeMerchant(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, "");
  s = s.split(/[/?#]/)[0] ?? s;
  s = s.replace(/:\d+$/, "");
  s = s.replace(/^www\./, "");
  return s;
}

/** True if merchant equals a list entry or is a subdomain of one. */
export function merchantInList(merchant: string, list: readonly string[]): boolean {
  const m = normalizeMerchant(merchant);
  return list.some((entry) => {
    const e = normalizeMerchant(entry);
    return e.length > 0 && (m === e || m.endsWith(`.${e}`));
  });
}
