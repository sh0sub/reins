/**
 * Layout check over raw CDP (no extra deps): every route must fit the viewport with no horizontal page scroll,
 * at 390x844 (phone) and 1440x900 (desktop). Start a server on a THROWAWAY database first (`pnpm judge -- --no-open`
 * or `REINS_TRY=1 DATABASE_URL=file:<scratch> pnpm dev:web`), then:
 *   pnpm check:layout -- --base http://localhost:3100
 *   pnpm check:layout -- --base http://localhost:3100 --shots ./some-dir   # also writes a PNG per route and size
 * Exits 1 when any route has scrollWidth > viewport width.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const BASE = opt("--base", "http://localhost:3100");
const SHOTS = opt("--shots", null);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const ROUTES = ["/overview", "/overview?playground=1", "/inbox", "/agents", "/ledger", "/setup", "/try", "/proof"];
const SIZES = [
  [390, 844],
  [1440, 900],
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = 9500 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(path.join(tmpdir(), "reins-layout-"));
const proc = spawn(CHROME, ["--headless=new", "--hide-scrollbars", "--mute-audio", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const done = (code) => {
  proc.once("exit", () => {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* a temp profile left behind is harmless */
    }
    process.exit(code);
  });
  proc.kill("SIGKILL");
};

let wsUrl;
for (let i = 0; i < 100 && !wsUrl; i++) {
  try {
    wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page")?.webSocketDebuggerUrl;
  } catch {
    /* Chrome is starting */
  }
  if (!wsUrl) await sleep(200);
}
if (!wsUrl) {
  console.error("check-layout: Chrome did not start (set CHROME_PATH)");
  done(2);
}
const sock = new WebSocket(wsUrl);
await new Promise((r, j) => ((sock.onopen = r), (sock.onerror = j)));
let id = 0;
const pending = new Map();
sock.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) pending.get(d.id)(d.result);
};
const send = (method, params = {}) => new Promise((res) => ((pending.set(++id, res), sock.send(JSON.stringify({ id, method, params })))));
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let bad = 0;
for (const [w, h] of SIZES) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
  for (const route of ROUTES) {
    await send("Page.navigate", { url: BASE + route });
    await sleep(2800);
    const sw = await ev("document.documentElement.scrollWidth");
    const cw = await ev("document.documentElement.clientWidth");
    const ok = sw <= cw;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${String(w).padStart(4)}px ${route.padEnd(24)} scrollWidth ${sw} / ${cw}`);
    if (SHOTS) writeFileSync(path.join(SHOTS, `${route.replace(/[^a-z0-9]+/gi, "_")}-${w}.png`), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  }
}
console.log(bad ? `check-layout: ${bad} route(s) overflow horizontally` : "check-layout: no horizontal overflow on any route");
done(bad ? 1 : 0);
