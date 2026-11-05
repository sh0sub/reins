"use client";

import { useMemo } from "react";
import { AgCharts } from "ag-charts-react";
import { BarSeriesModule, CategoryAxisModule, ModuleRegistry, NumberAxisModule, type AgCartesianChartOptions } from "ag-charts-community";
import type { LedgerRow } from "@reins/core";
import { usdAmount } from "@/lib/format";

ModuleRegistry.registerModules([BarSeriesModule, CategoryAxisModule, NumberAxisModule]);

/** AG Charts (community): paid spend per agent this month. Canvas cannot read CSS variables, so the colours
 * mirror theme.css (--reins-navy, --reins-ink, --reins-ink-2, --reins-line). */
export function SpendChart({ rows }: { rows: LedgerRow[] }) {
  const data = useMemo(() => {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const by = new Map<string, number>();
    for (const r of rows) {
      if (r.status !== "paid" || Date.parse(r.created_at) < monthStart.getTime()) continue;
      by.set(r.agent_name, (by.get(r.agent_name) ?? 0) + Number(r.amount));
    }
    return [...by.entries()].map(([agent, paid]) => ({ agent, paid: Math.round(paid * 100) / 100 })).sort((a, b) => b.paid - a.paid);
  }, [rows]);

  const options = useMemo<AgCartesianChartOptions>(
    () => ({
      data,
      height: 220,
      background: { visible: false },
      padding: { top: 8, right: 56, bottom: 8, left: 8 },
      series: [
        {
          type: "bar",
          direction: "horizontal",
          xKey: "agent",
          yKey: "paid",
          yName: "Paid this month",
          fill: "#003087",
          cornerRadius: 4,
          label: { formatter: ({ value }: { value: number }) => usdAmount(value), placement: "outside-end", color: "#0b1f4d", fontWeight: "bold" },
        },
      ],
      axes: {
        x: { type: "category", position: "left", label: { color: "#4b5670" } },
        y: { type: "number", position: "bottom", label: { formatter: ({ value }: { value: number }) => `$${value}`, color: "#4b5670" }, gridLine: { style: [{ stroke: "#e3e8f0" }] } },
      },
      legend: { enabled: false },
    }),
    [data],
  );

  if (!data.length) return <p className="caption">No paid purchases this month yet.</p>;
  return (
    <div role="img" aria-label={`Paid this month by agent: ${data.map((d) => `${d.agent} ${usdAmount(d.paid)}`).join(", ")}`}>
      <AgCharts options={options} />
    </div>
  );
}
