/**
 * Demo agent B (S6): a DevOps cron agent. Once a day (Render Cron Job) it checks the infra cost sheet, finds bills
 * due in the next few days and pays the small ones through Reins MCP `request_purchase`. Each bill uses the
 * idempotency key devops-<merchant>-<item>-<YYYY-MM>, so running twice a day (or retrying after a crash) never
 * pays a bill twice. Bills above the auto-approve limit are left for a human unless --ask is passed.
 *
 *   REINS_API_URL=http://localhost:3000 REINS_API_KEY=rk_live_... pnpm agent:devops [--ask] [--days 3] [--dry-run]
 *
 * The agent only talks MCP: it spawns the Reins stdio MCP server (apps/mcp/src/stdio.ts) as a child process, or, when
 * REINS_MCP_URL (or REINS_MCP_HOSTPORT, Render private network) is set, connects to the Streamable HTTP server instead
 * (the Render Cron job in render.yaml does this).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface InfraBill {
  merchant: string;
  item: string;
  /** Decimal string, e.g. "7.00". */
  amount: string;
  /** Day of the month the bill is due (1-28). */
  due_day: number;
  category?: string;
}

export interface ToolResult {
  text: string;
  data: Record<string, unknown> | undefined;
  isError?: boolean;
}
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

export type BillOutcome =
  | { bill: InfraBill; due: string; action: "requested"; status: string; request_id: string; summary: string }
  | { bill: InfraBill; due: string; action: "skipped"; why: string }
  | { bill: InfraBill; due: string; action: "error"; why: string };

export interface DevOpsReport {
  checked: number;
  due: number;
  outcomes: BillOutcome[];
  lines: string[];
}

const DAY = 86_400_000;
const cents = (v: string) => Math.round(Number(v) * 100);
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** Next due date (UTC midnight) of a monthly bill, on or after today; overdue by up to `graceDays` counts as this month. */
export function nextDue(bill: Pick<InfraBill, "due_day">, now: number, graceDays = 2): Date {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const thisMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), bill.due_day);
  if (thisMonth >= today - graceDays * DAY) return new Date(thisMonth);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, bill.due_day));
}

function merchantMatches(merchant: string, list: string[]): boolean {
  const m = merchant.toLowerCase();
  return list.some((e) => m === e.toLowerCase() || m.endsWith(`.${e.toLowerCase()}`));
}

/**
 * One daily run. Reads the mandate first (get_mandate), then requests each due bill that fits the auto-approve
 * limit for its merchant. Never retries a denied bill: Reins already told the user why.
 */
export async function runDevOpsCheck(opts: { call: CallTool; bills: InfraBill[]; now: number; dueWithinDays?: number; askAboveLimit?: boolean; dryRun?: boolean }): Promise<DevOpsReport> {
  const { call, bills, now } = opts;
  const window = (opts.dueWithinDays ?? 3) * DAY;
  const lines: string[] = [];
  const outcomes: BillOutcome[] = [];

  const m = await call("get_mandate", {});
  if (m.isError || !m.data) {
    return { checked: bills.length, due: 0, outcomes, lines: [`Could not read the Reins mandate: ${m.text}`] };
  }
  const mandate = (m.data.mandate ?? {}) as { auto_approve_limit?: string; allowed_merchants?: string[]; categories?: string[]; merchant_auto_limits?: Record<string, string> };
  const categories = mandate.categories ?? [];
  const baseAuto = cents(mandate.auto_approve_limit ?? "0");
  const allowed = mandate.allowed_merchants ?? [];
  const merchantRules = mandate.merchant_auto_limits ?? {};
  const autoFor = (merchant: string) =>
    Object.entries(merchantRules).reduce((lim, [k, v]) => (merchantMatches(merchant, [k]) ? Math.max(lim, cents(v)) : lim), baseAuto);

  const due = bills
    .map((bill) => ({ bill, date: nextDue(bill, now) }))
    .filter(({ date }) => date.getTime() - now <= window)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const totalDue = due.reduce((s, d) => s + cents(d.bill.amount), 0);
  lines.push(`Infra cost check: ${due.length} of ${bills.length} bills due in the next ${opts.dueWithinDays ?? 3} days (${usd(totalDue)}).`);

  for (const { bill, date } of due) {
    const dueIso = date.toISOString().slice(0, 10);
    const amount = cents(bill.amount);
    const limit = autoFor(bill.merchant);
    if (allowed.length && !merchantMatches(bill.merchant, allowed)) {
      outcomes.push({ bill, due: dueIso, action: "skipped", why: `${bill.merchant} is not in my mandate` });
      continue;
    }
    if (amount > limit && !opts.askAboveLimit) {
      outcomes.push({ bill, due: dueIso, action: "skipped", why: `${usd(amount)} is above my ${usd(limit)} auto-approve limit; left for you` });
      continue;
    }
    if (opts.dryRun) {
      outcomes.push({ bill, due: dueIso, action: "skipped", why: "dry run" });
      continue;
    }
    const period = dueIso.slice(0, 7);
    const r = await call("request_purchase", {
      merchant: bill.merchant,
      amount: bill.amount,
      items: bill.item,
      reason: `Monthly infrastructure bill due ${dueIso}; paying it keeps production running`,
      // only send a category the mandate knows; an unknown one would be flagged as off-mandate (S3)
      ...(bill.category && categories.includes(bill.category) ? { category: bill.category } : {}),
      client_request_id: `devops-${slug(bill.merchant)}-${slug(bill.item)}-${period}`,
    });
    if (r.isError || !r.data) outcomes.push({ bill, due: dueIso, action: "error", why: r.text });
    else outcomes.push({ bill, due: dueIso, action: "requested", status: String(r.data.status), request_id: String(r.data.request_id), summary: r.text.split("\n")[0] ?? "" });
  }

  for (const o of outcomes) {
    const head = `- ${o.bill.merchant} ${usd(cents(o.bill.amount))} (due ${o.due}):`;
    lines.push(o.action === "requested" ? `${head} ${o.summary}` : o.action === "skipped" ? `${head} skipped, ${o.why}.` : `${head} error, ${o.why}`);
  }
  return { checked: bills.length, due: due.length, outcomes, lines };
}

/** Streamable HTTP MCP endpoint, or null for the stdio child process. */
export function mcpUrlFromEnv(env: Record<string, string | undefined>): string | null {
  if (env.REINS_MCP_URL) return env.REINS_MCP_URL;
  if (env.REINS_MCP_HOSTPORT) return `http://${env.REINS_MCP_HOSTPORT}/mcp`;
  return null;
}

export function loadBills(file: string): InfraBill[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { bills?: InfraBill[] };
  return (raw.bills ?? []).filter((b) => b.merchant && b.item && /^\d+(\.\d{1,2})?$/.test(b.amount) && b.due_day >= 1 && b.due_day <= 28);
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const args = process.argv.slice(2);
  const key = process.env.REINS_API_KEY;
  if (!key) {
    console.error("[devops-agent] REINS_API_KEY is required (create the agent in /agents and copy its key)");
    process.exit(1);
  }
  const days = Number(args[args.indexOf("--days") + 1]);
  const bills = loadBills(process.env.DEVOPS_COSTS_FILE ?? resolve(root, "agents/devops/infra-costs.json"));

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const mcpUrl = mcpUrlFromEnv(process.env);
  const transport = mcpUrl
    ? new (await import("@modelcontextprotocol/sdk/client/streamableHttp.js")).StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      })
    : new (await import("@modelcontextprotocol/sdk/client/stdio.js")).StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", resolve(root, "apps/mcp/src/stdio.ts")],
        cwd: root,
        env: { PATH: process.env.PATH ?? "", REINS_API_URL: process.env.REINS_API_URL ?? "http://localhost:3000", REINS_API_KEY: key },
        stderr: "ignore",
      });
  const client = new Client({ name: "reins-devops-cron", version: "0.1.0" });
  await client.connect(transport);
  const call: CallTool = async (name, a) => {
    const r = await client.callTool({ name, arguments: a });
    return { text: (r.content as Array<{ text?: string }>)[0]?.text ?? "", data: r.structuredContent as Record<string, unknown> | undefined, isError: Boolean(r.isError) };
  };
  try {
    const report = await runDevOpsCheck({ call, bills, now: Date.now(), dueWithinDays: Number.isFinite(days) && days > 0 ? days : 3, askAboveLimit: args.includes("--ask"), dryRun: args.includes("--dry-run") });
    console.log(report.lines.join("\n"));
    if (report.outcomes.some((o) => o.action === "error")) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error(`[devops-agent] failed: ${err.message}`);
    process.exit(1);
  });
}
