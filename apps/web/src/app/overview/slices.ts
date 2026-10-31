/** Mirrors --reins-series-1..5 / --reins-series-other in theme.css (canvas cannot read CSS variables). */
export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4"];
export const SERIES_OTHER = "#8a93a6";

export interface CategorySlice {
  category: string;
  cents: number;
  color: string;
  /** Request categories behind the slice: itself, or every category folded into "Other". */
  members: string[];
}

/** Ledger deep link for a slice (S7: a donut slice filters the ledger by category, same period). */
export const sliceHref = (s: Pick<CategorySlice, "members">, period: string) =>
  `/ledger?category=${encodeURIComponent(s.members.join(","))}&period=${period}`;

/** At most 5 named categories in fixed colour order; the rest fold into "Other". */
export function toSlices(categories: Array<{ category: string; cents: number }>): CategorySlice[] {
  const named = categories.slice(0, SERIES.length).map((c, i) => ({ ...c, color: SERIES[i]!, members: [c.category] }));
  const others = categories.slice(SERIES.length);
  const rest = others.reduce((s, c) => s + c.cents, 0);
  return rest > 0 ? [...named, { category: "Other", cents: rest, color: SERIES_OTHER, members: others.map((c) => c.category) }] : named;
}

