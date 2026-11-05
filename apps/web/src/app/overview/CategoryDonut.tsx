"use client";

import { useMemo } from "react";
import { AgCharts } from "ag-charts-react";
import { DonutSeriesModule, ModuleRegistry, type AgPolarChartOptions } from "ag-charts-community";
import { usd, usdAmount } from "@/lib/format";
import type { CategorySlice } from "./slices";

ModuleRegistry.registerModules([DonutSeriesModule]);

/** Mirror --reins-ink / --reins-ink-2 in theme.css. */
const INK = "#14213d";
const INK_2 = "#4b5670";

/** AG Charts donut: committed spend this month by request category, total in the centre. */
export function CategoryDonut({ slices, totalCents, caption, onSelect }: { slices: CategorySlice[]; totalCents: number; caption: string; onSelect?: (s: CategorySlice) => void }) {
  const options = useMemo<AgPolarChartOptions>(
    () => ({
      data: slices.map((s, i) => ({ category: s.category, dollars: s.cents / 100, i })),
      height: 200,
      minWidth: 160,
      background: { visible: false },
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      legend: { enabled: false },
      series: [
        {
          type: "donut",
          angleKey: "dollars",
          angleName: "Spent",
          legendItemKey: "category",
          fills: slices.map((s) => s.color),
          strokes: ["#ffffff"],
          strokeWidth: 2,
          innerRadiusRatio: 0.66,
          innerLabels: [
            { text: usd(totalCents), fontSize: 20, fontWeight: "bold", color: INK },
            { text: caption, fontSize: 12, color: INK_2, spacing: 4 },
          ],
          cursor: onSelect ? "pointer" : undefined,
          // S7: a slice click filters the ledger by that category (the legend links next to the chart do the same by keyboard)
          listeners: onSelect ? { seriesNodeClick: ({ datum }: { datum: { i: number } }) => slices[datum.i] && onSelect(slices[datum.i]!) } : undefined,
          tooltip: {
            renderer: ({ datum }: { datum: { category: string; dollars: number } }) => ({
              heading: datum.category,
              data: [{ label: "Spent", value: usdAmount(datum.dollars) }, ...(onSelect ? [{ label: "Click", value: "open in ledger" }] : [])],
            }),
          },
        },
      ],
    }),
    [slices, totalCents, caption, onSelect],
  );
  return <AgCharts options={options} />;
}
