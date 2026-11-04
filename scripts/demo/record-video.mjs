#!/usr/bin/env node
/**
 * Demo video recorder for Reins: drives the real dashboard in headless Chrome (raw CDP, no extra deps), makes the
 * agent side of the story with real MCP tool calls, narrates each shot with macOS `say`, and writes one 1920x1080 MP4.
 *
 *   node scripts/demo/record-video.mjs
 *   node scripts/demo/record-video.mjs --work /some/scratch/dir --out .local/video/reins-demo.mp4
 *
 * Options: --port 3927 (web)  --mcp-port 3933  --work <frames/audio/DB dir, default .local/video/work>
 *          --out <mp4>  --shots <gallery dir, default .local/screenshots>  --voice Samantha  --rate 182  --stills 8
 *          --real <dir with real-run.json + reins-real.db from scripts/demo/real-run.mjs>  --real-port 3943
 *            (adds the ~10 s "real run" beat: a read-only server on a copy of that DB; without --real the beat is skipped)
 *
 * What it runs (all offline, nothing real is called):
 *  - a fresh scratch DB at <work>/reins-video.db: `pnpm seed -- --db`, then scripts/demo/prep-db.mjs (removes the three
 *    seeded requests the video re-creates live, fake vault, fresh agent keys kept in memory only)
 *  - `next dev` for apps/web with PAYPAL_ENV=fake, ANTHROPIC_API_KEY="" (offline mock auditor), TELEGRAM_MODE=off,
 *    REINS_QUIET_HOURS=off. The root .env is NOT loaded (next is started without --env-file), and the PayPal/Telegram/
 *    Anthropic variables are blanked on the command line anyway.
 *  - the MCP Streamable HTTP server (apps/mcp/src/http.ts) pointed at that web server; the recorder calls it with
 *    JSON-RPC tools/call exactly like an MCP client would
 * Both servers and Chrome are stopped at the end. Needs: Google Chrome, ffmpeg/ffprobe, sqlite3, macOS `say`.
 * Shot list + narration: scripts/demo/video-shots.mjs. ffmpeg here lacks drawtext/libass, so subtitles, lower-thirds
 * and title cards are rendered by Chrome as transparent PNGs and overlaid. Layout: the dashboard fills ~92% of the frame;
 * each shot opens with a 1.5 s lower-third, narration shows as a caption, and `zoom` actions punch in 1.3x on a card.
 * Recording-only touches (injected into the page, not product code): the Korean audit line is hidden (the product shows
 * it) and the sidebar's Telegram line reads "Telegram: demo" because the bot is switched off for the recording.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SEGMENTS } from "./video-shots.mjs";
import { prepVideoDb } from "./prep-db.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]] : acc), []),
);
const PORT = Number(args.port ?? 3927);
const MCP_PORT = Number(args["mcp-port"] ?? 3933);
const BASE = `http://localhost:${PORT}`;
const MCP_URL = `http://localhost:${MCP_PORT}/mcp`;
const WORK = path.resolve(args.work ?? path.join(ROOT, ".local/video/work"));
const OUT = path.resolve(args.out ?? path.join(ROOT, ".local/video/reins-demo.mp4"));
const SHOTS = path.resolve(args.shots ?? path.join(ROOT, ".local/screenshots"));
const DB_FILE = path.join(WORK, "reins-video.db");
const VOICE = args.voice ?? "Samantha";
const RATE = Number(args.rate ?? 182);
const STILLS = Number(args.stills ?? 8);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FFMPEG = existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
const FFPROBE = existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "ffprobe";
const REAL_DIR = args.real ? path.resolve(args.real) : null;
const REAL_PORT = Number(args["real-port"] ?? 3943);
const REAL_BASE = `http://localhost:${REAL_PORT}`;
const REPO_URL = "github.com/sh0sub/reins";
const TZ = "America/Los_Angeles";

// Layout (1920x1080): the dashboard screen is full-bleed (1766 px = 92% of the width); captions are overlays on it.
const W = 1920, H = 1080, FPS = 30;
const VW = 1440, VH = 840, DPR = 1.75; // recorded viewport (CSS px) and device scale (1.75 -> 2520 px frames, enough for a 1.4x punch-in)
const SCR_W = 1766, SCR_H = 1030, SCR_X = 77, SCR_Y = 12;
const K = SCR_W / VW; // CSS px -> output px
const HI = 1.4; // the screen layer is scaled to 1.4x once, zooms crop from it
const LEAD = 0.5, GAP = 0.3, TAIL = 0.9;
const L3_TO = 1.8; // lower-third window ends 1.8 s into each shot

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[rec ${new Date().toISOString().slice(11, 19)}]`, ...a);
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20, ...opts }).toString();
const probe = (f) => Number(run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).trim());
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const lineText = (l) => (Array.isArray(l) ? l[0] : l);
const lineSay = (l) => (Array.isArray(l) ? l[1] : l);

const cleanup = [];
async function shutdown(code) {
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(130));

/* ── 1. narration audio (one file per line → exact subtitle timing) ───────────── */
function buildAudio() {
  const dir = path.join(WORK, "audio");
  mkdirSync(dir, { recursive: true });
  const silence = (sec, f) => run(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", sec.toFixed(3), "-c:a", "pcm_s16le", f]);
  for (const seg of SEGMENTS) {
    const parts = [];
    const cues = [];
    let t = LEAD;
    const lead = path.join(dir, `${seg.id}-lead.wav`);
    silence(LEAD, lead);
    parts.push(lead);
    seg.lines.forEach((line, i) => {
      const aiff = path.join(dir, `${seg.id}-${i}.aiff`);
      const wav = path.join(dir, `${seg.id}-${i}.wav`);
      run("/usr/bin/say", ["-v", VOICE, "-r", String(RATE), "-o", aiff, lineSay(line)]);
      run(FFMPEG, ["-y", "-v", "error", "-i", aiff, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
      const d = probe(wav);
      cues.push({ start: t, end: t + d, text: lineText(line) });
      parts.push(wav);
      t += d;
      if (i < seg.lines.length - 1) {
        const g = path.join(dir, `${seg.id}-gap${i}.wav`);
        silence(GAP, g);
        parts.push(g);
        t += GAP;
      }
    });
    const tail = path.join(dir, `${seg.id}-tail.wav`);
    silence(TAIL, tail);
    parts.push(tail);
    const list = path.join(dir, `${seg.id}-list.txt`);
    writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
    seg.audio = path.join(dir, `${seg.id}.wav`);
    run(FFMPEG, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c:a", "pcm_s16le", seg.audio]);
    seg.cues = cues;
    seg.audioDur = probe(seg.audio);
    log(`audio ${seg.id}: ${seg.audioDur.toFixed(2)}s, ${seg.lines.map(lineText).join(" ").split(/\s+/).length} words`);
  }
}

/* ── CDP plumbing ──────────────────────────────────────────────────────────── */
async function launchChrome() {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = path.join(WORK, "chrome-profile");
  rmSync(profile, { recursive: true, force: true });
  // no --disable-gpu: it broke screencast frames in the mirror-tutor recorder. On macOS --lang is ignored, so the
  // Cocoa argument "-AppleLanguages (en-US)" sets the UI locale (native date inputs); headless allows one target, so no
  // about:blank (Chrome opens "(en-US)" as its first tab, which is navigated away right after)
  const proc = spawn(CHROME, ["--headless=new", "--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${VW},${VH}`, "--lang=en-US", "--accept-lang=en-US", "-AppleLanguages", "(en-US)"], {
    stdio: "ignore",
    env: { ...process.env, LANG: "en_US.UTF-8", TZ },
  });
  cleanup.push(() => proc.kill("SIGKILL"));
  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error("Chrome did not start");
  const sock = new WebSocket(wsUrl);
  await new Promise((r, j) => ((sock.onopen = r), (sock.onerror = j)));
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  sock.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { res, rej } = pending.get(d.id);
      pending.delete(d.id);
      if (d.error) rej(new Error(`${d.error.message} ${d.error.data ?? ""}`));
      else res(d.result);
    } else if (d.method) listeners.get(d.method)?.forEach((fn) => fn(d.params));
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      sock.send(JSON.stringify({ id: i, method, params }));
    });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  return { send, on };
}

/* ── 2. stage graphics (one RGBA PNG per subtitle cue) ─────────────────────── */
const FONT = `-apple-system,"SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif`;
const FOOT = "Recorded locally on a scratch database: fake PayPal client (no money moves), offline stand-in for the Claude auditor, Telegram off. The real-run beat is a separate recording.";

function cardHtml(seg, ci) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;font-family:${FONT};-webkit-font-smoothing:antialiased}
    body{background:radial-gradient(1200px 700px at 30% 20%,#1e3a8a 0%,#0b1736 60%,#081028 100%);color:#fff}
    .wrap{position:absolute;left:180px;right:180px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:34px}
    .brand{display:flex;align-items:center;gap:18px;font-size:34px;font-weight:800;letter-spacing:-.01em}
    .brand i{display:block;width:40px;height:40px;border-radius:11px;background:#3b82f6}
    h1{margin:0;font-size:120px;line-height:1;font-weight:800;letter-spacing:-.03em}
    .tag{font-size:44px;line-height:1.25;font-weight:600;color:#dbe6ff;max-width:1400px}
    .row{display:flex;gap:18px;flex-wrap:wrap}
    .pill{border:2px solid #3b5bab;border-radius:999px;padding:12px 26px;font-size:28px;font-weight:600;color:#dbe6ff}
    .url{font-size:40px;font-weight:700;color:#93c5fd;font-family:Menlo,monospace}
    .sub{font-size:30px;line-height:1.4;color:#c7d4f3;min-height:84px}
    </style></head><body><div class="wrap">
    <div class="brand"><i></i>Reins</div>
    <h1>Per agent, per dollar.</h1>
    <div class="tag">Budgets, hard rules, one-tap human approval and an audit trail for AI agents that pay with PayPal.</div>
    <div class="row"><span class="pill">MCP server</span><span class="pill">Orders v2 · Payouts · Webhooks · Transaction Search</span><span class="pill">Open source · MIT</span></div>
    <div class="url">${REPO_URL}</div>
    <div class="sub">${esc(seg.cues[ci].text)}</div>
    </div></body></html>`;
}

/**
 * Transparent overlay over the full-bleed dashboard: hole (canvas frame), footer note, optional badge, and per cue
 * the caption (bottom of the screen). `l3` adds the 1.5 s lower-third; `big` is the 2 s statement over the live frame.
 */
function stageHtml(seg, { text, l3, big }) {
  const bottom = H - (SCR_Y + SCR_H); // canvas band under the screen
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden;font-family:${FONT};color:#0f172a;-webkit-font-smoothing:antialiased}
  .hole{position:absolute;left:${SCR_X}px;top:${SCR_Y}px;width:${SCR_W}px;height:${SCR_H}px;border-radius:16px;box-shadow:0 0 0 1px #c7d2fe,0 18px 48px 0 rgba(30,58,138,.16),0 0 0 3000px #eef2ff}
  .foot{position:absolute;left:${SCR_X}px;width:${SCR_W}px;bottom:0;height:${bottom}px;display:flex;align-items:center;justify-content:space-between;font-size:15px;color:#64748b}
  .foot b{display:flex;align-items:center;gap:8px;color:#0b2a6f;font-size:17px;font-weight:800}
  .foot b i{display:block;width:16px;height:16px;border-radius:5px;background:#1d4ed8}
  .l3{position:absolute;left:${SCR_X + 36}px;bottom:${bottom + 128}px;max-width:900px;background:rgba(255,255,255,.96);border-left:7px solid #1d4ed8;border-radius:14px;padding:16px 26px 18px 22px;box-shadow:0 14px 40px rgba(15,23,42,.28)}
  .l3 .k{font-size:19px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#1d4ed8}
  .l3 h1{margin:2px 0 8px;font-size:42px;line-height:1.1;font-weight:800;letter-spacing:-.015em}
  .l3 .c{display:inline-block;background:#dbe4ff;color:#1e3a8a;border-radius:999px;padding:7px 16px;font-size:18px;font-weight:700}
  .badge{position:absolute;left:${SCR_X + 24}px;top:${SCR_Y + 84}px;background:#fef3c7;color:#92400e;border:1px solid #f59e0b;border-radius:999px;padding:9px 20px;font-size:20px;font-weight:800;letter-spacing:.03em;box-shadow:0 6px 20px rgba(15,23,42,.2)}
  .sub{position:absolute;left:${SCR_X}px;width:${SCR_W}px;bottom:${bottom + 22}px;display:flex;justify-content:center;pointer-events:none}
  .sub span{max-width:1480px;text-align:center;font-size:31px;line-height:1.3;font-weight:600;color:#fff;background:rgba(11,23,54,.88);border-radius:14px;padding:10px 26px 12px;box-shadow:0 10px 30px rgba(15,23,42,.3)}
  .big{position:absolute;left:${SCR_X}px;width:${SCR_W}px;top:${SCR_Y + SCR_H / 2 - 120}px;height:190px;display:flex;align-items:center;justify-content:center;background:rgba(11,23,54,.84)}
  .big span{font-size:84px;font-weight:800;letter-spacing:-.02em;color:#fff}
  </style></head><body>
  <div class="hole"></div>
  <div class="foot"><b><i></i>Reins</b><span>${esc(FOOT)}</span><span></span></div>
  ${seg.badge ? `<div class="badge">${esc(seg.badge)}</div>` : ""}
  ${l3 ? `<div class="l3"><div class="k">${esc(seg.kicker)}</div><h1>${esc(seg.heading)}</h1><span class="c">${esc(seg.chip)}</span></div>` : ""}
  ${big ? `<div class="big"><span>${esc(text)}</span></div>` : text ? `<div class="sub"><span>${esc(text)}</span></div>` : ""}
  </body></html>`;
}

async function renderStage(cdp) {
  const dir = path.join(WORK, "stage");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  for (const seg of SEGMENTS) {
    seg.stage = []; // [{ png, start }] background overlay changes over the shot
    const shoot = async (name, html, start) => {
      const f = path.join(dir, `${name}.html`);
      const png = path.join(dir, `${name}.png`);
      writeFileSync(f, html);
      await cdp.send("Page.navigate", { url: `file://${f}` });
      await sleep(250);
      writeFileSync(png, Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
      seg.stage.push({ png, start });
    };
    for (const [ci, cue] of seg.cues.entries()) {
      const start = ci === 0 ? 0 : cue.start;
      if (seg.card) await shoot(`${seg.id}-${ci}`, cardHtml(seg, ci), start);
      else if (seg.bigLast && ci === seg.cues.length - 1) await shoot(`${seg.id}-${ci}`, stageHtml(seg, { text: cue.text, big: true }), start);
      else if (ci === 0) {
        await shoot(`${seg.id}-${ci}-l3`, stageHtml(seg, { text: cue.text, l3: true }), 0);
        if (!seg.cues[1] || seg.cues[1].start > L3_TO + 0.05) await shoot(`${seg.id}-${ci}`, stageHtml(seg, { text: cue.text }), L3_TO);
      } else await shoot(`${seg.id}-${ci}`, stageHtml(seg, { text: cue.text }), start);
    }
  }
  await cdp.send("Emulation.setDefaultBackgroundColorOverride", {});
  log(`stage graphics: ${SEGMENTS.reduce((n, s) => n + s.stage.length, 0)} PNGs`);
}

/* ── 3. scratch DB + servers ───────────────────────────────────────────────── */
let agentKeys = {};

async function portFree(port) {
  try {
    await fetch(`http://localhost:${port}/`);
    return false;
  } catch {
    return true;
  }
}

function prepareDb() {
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, `${DB_FILE}-journal`]) rmSync(f, { force: true });
  const out = run("pnpm", ["seed", "--", "--db", DB_FILE], { cwd: ROOT, env: { ...process.env, DATABASE_URL: `file:${DB_FILE}` } });
  log(out.trim().split("\n").slice(0, 2).join(" | "));
  agentKeys = prepVideoDb(DB_FILE, WORK); // keys stay in memory; never logged
  log(`scratch DB ready: ${DB_FILE} (agents: ${Object.keys(agentKeys).join(", ")})`);
}

function spawnServer(name, cmd, argv, cwd, env) {
  const logFile = path.join(WORK, `${name}.log`);
  const fd = openSync(logFile, "w");
  const proc = spawn(cmd, argv, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
  cleanup.push(() => {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  });
  return logFile;
}

async function startServers() {
  if (!(await portFree(PORT))) throw new Error(`port ${PORT} is already in use; stop that server or pass --port`);
  if (!(await portFree(MCP_PORT))) throw new Error(`port ${MCP_PORT} is already in use; stop that server or pass --mcp-port`);
  const env = {
    ...process.env,
    DATABASE_URL: `file:${DB_FILE}`,
    PAYPAL_ENV: "fake",
    PAYPAL_CLIENT_ID: "",
    PAYPAL_CLIENT_SECRET: "",
    PAYPAL_WEBHOOK_ID: "",
    ANTHROPIC_API_KEY: "",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_MODE: "off",
    REINS_QUIET_HOURS: "off",
    REINS_TIMEZONE: TZ,
    REINS_APPROVAL_TTL_MINUTES: "240",
    REINS_ADMIN_TOKEN: "",
    PUBLIC_BASE_URL: BASE,
    REINS_API_URL: BASE,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  // no --env-file: the root .env is never read by this run
  const webLog = spawnServer("web", process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", String(PORT)], path.join(ROOT, "apps/web"), env);
  const mcpLog = spawnServer("mcp", path.join(ROOT, "node_modules/.bin/tsx"), ["apps/mcp/src/http.ts"], ROOT, { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(MCP_PORT), REINS_API_URL: BASE });
  for (let i = 0; i < 180; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* booting */
    }
    await sleep(500);
  }
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${MCP_PORT}/health`)).ok) break;
    } catch {
      /* booting */
    }
    await sleep(500);
  }
  const ov = await (await fetch(`${BASE}/api/overview`)).json();
  if (ov.paypal_env !== "fake") throw new Error(`web server is not in fake PayPal mode (${ov.paypal_env})`);
  log(`web on ${BASE} (log ${webLog}), MCP on ${MCP_URL} (log ${mcpLog}); month so far $${(ov.totals.spent_cents / 100).toFixed(2)}`);
  // compile every route once so the first visit in the recording is not a blank dev compile
  for (const p of ["/overview", "/inbox", "/agents", "/ledger", "/setup", "/receipts/none", "/api/inbox", "/api/ledger", "/api/agents", "/api/overview/summary"]) await fetch(BASE + p).catch(() => null);
  if (REAL_DIR) await startRealView(env);
}

/** Read-only server on a COPY of the real-run DB (scripts/demo/real-run.mjs). No PayPal/Claude credentials, Telegram off. */
async function startRealView(baseEnv) {
  if (!(await portFree(REAL_PORT))) throw new Error(`port ${REAL_PORT} is already in use; pass --real-port`);
  const src = path.join(REAL_DIR, "reins-real.db");
  if (!existsSync(src) || !existsSync(path.join(REAL_DIR, "real-run.json"))) throw new Error(`--real ${REAL_DIR} needs reins-real.db and real-run.json (run scripts/demo/real-run.mjs)`);
  const dst = path.join(WORK, "reins-real-view.db");
  for (const f of [dst, `${dst}-wal`, `${dst}-shm`]) rmSync(f, { force: true });
  run("/usr/bin/sqlite3", [src, `.backup '${dst}'`]);
  const env = { ...baseEnv, DATABASE_URL: `file:${dst}`, PAYPAL_ENV: "sandbox", PUBLIC_BASE_URL: REAL_BASE, REINS_API_URL: REAL_BASE, REINS_NEXT_DIST_DIR: ".next-real" };
  const logFile = spawnServer("web-real", process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", String(REAL_PORT)], path.join(ROOT, "apps/web"), env);
  for (let i = 0; i < 180; i++) {
    try {
      if ((await fetch(`${REAL_BASE}/api/health`)).ok) break;
    } catch {
      /* booting */
    }
    await sleep(500);
  }
  const ws = await (await fetch(`${REAL_BASE}/api/workspace`)).json();
  if (ws.paypal_env !== "sandbox") throw new Error(`real view DB is not a sandbox workspace (${ws.paypal_env})`);
  for (const p of ["/ledger", "/api/ledger", "/api/agents"]) await fetch(REAL_BASE + p).catch(() => null);
  log(`real-run view on ${REAL_BASE} (log ${logFile})`);
}

let mcpId = 0;
const mcpLog = [];
async function mcpCall(agent, tool, toolArgs) {
  const key = agentKeys[agent];
  if (!key) throw new Error(`no key for agent ${agent}`);
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++mcpId, method: "tools/call", params: { name: tool, arguments: toolArgs } }),
  });
  const body = await res.json();
  if (!res.ok || body.error || body.result?.isError) throw new Error(`MCP ${tool} failed: ${JSON.stringify(body.error ?? body.result?.content ?? res.status)}`);
  const out = { args: toolArgs, text: body.result.content[0].text, data: body.result.structuredContent };
  mcpLog.push({ agent, tool, arguments: toolArgs, result: body.result });
  log(`  MCP ${agent} ${tool} -> ${out.text.split("\n")[0]}`);
  return out;
}

function cardText(view, agentName, kind, budget) {
  const f = path.join(WORK, "card-input.json");
  writeFileSync(f, JSON.stringify({ kind, view, agentName, budget, ttlMinutes: 30 }));
  return JSON.parse(run(path.join(ROOT, "node_modules/.bin/tsx"), ["scripts/demo/card-text.ts", f], { cwd: ROOT }));
}

/* ── in-page overlays (terminal card, Telegram card text, tap marker) ──────── */
const TERM_CSS = `position:fixed;inset:auto;margin:0;right:28px;top:84px;width:640px;max-height:760px;overflow:hidden;padding:0;border:0;border-radius:14px;background:#0f172a;color:#e2e8f0;box-shadow:0 24px 60px rgba(15,23,42,.45);font:14px/1.45 Menlo,Monaco,monospace;z-index:2147483647`;
const termHtml = (t) => `<style>
  #demo-term .h{display:flex;align-items:center;gap:8px;padding:12px 16px;background:#1e293b;color:#cbd5e1;font:600 13px/1.2 -apple-system,Helvetica,Arial,sans-serif;border-radius:14px 14px 0 0}
  #demo-term .h b{display:inline-block;width:9px;height:9px;border-radius:50%;background:#22c55e}
  #demo-term .bd{padding:14px 18px 16px}
  #demo-term pre{margin:4px 0 12px;white-space:pre-wrap;word-break:break-word;color:#cbd5e1;font:13px/1.45 Menlo,Monaco,monospace}
  #demo-term .c{color:#93c5fd;font-weight:700;margin-top:2px;white-space:pre-wrap}
  #demo-term .c.ok{color:#4ade80}#demo-term .c.warn{color:#fbbf24}#demo-term .c.bad{color:#f87171}#demo-term .c.dim{color:#64748b}
  </style><div class="h"><b></b>${esc(t.title)}</div><div class="bd">${t.body}</div>`;
const TG_CSS = `position:fixed;inset:auto;margin:0;right:28px;bottom:28px;width:560px;padding:0;border:1px solid #cbd5e1;border-radius:14px;background:#ffffff;color:#0f172a;box-shadow:0 18px 48px rgba(15,23,42,.25);font:15px/1.45 -apple-system,Helvetica,Arial,sans-serif;z-index:2147483647`;
const tgHtml = (title, card) => `<style>
  #demo-tg .h{padding:12px 16px;border-bottom:1px solid #e2e8f0;font-weight:700;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#475569}
  #demo-tg pre{margin:0;padding:14px 16px 6px;white-space:pre-wrap;font:14px/1.5 Menlo,Monaco,monospace;color:#0f172a}
  #demo-tg .b{display:flex;flex-wrap:wrap;gap:8px;padding:8px 16px 16px}
  #demo-tg .b span{border:1px solid #94a3b8;border-radius:8px;padding:6px 12px;font-size:14px;font-weight:600;color:#1e293b}
  </style><div class="h">${esc(title)}</div><pre>${esc(card.text)}</pre>${card.buttons.length ? `<div class="b">${card.buttons.flat().map((b) => `<span>${esc(b)}</span>`).join("")}</div>` : ""}`;

/* ── 4. recording ──────────────────────────────────────────────────────────── */
async function setupPage(cdp) {
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: DPR, mobile: false });
  await cdp.send("Emulation.setLocaleOverride", { locale: "en-US" }).catch(() => null);
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: TZ }).catch(() => null);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    // recording-only: hide the Korean audit line (the product shows it), and label the sidebar's Telegram line "demo"
    // (the bot is off for the recording; the card text in the video comes from the real bot code)
    source: `document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');
      s.textContent='nextjs-portal{display:none!important}[lang="ko"]{display:none!important}dt:has(+ dd[lang="ko"]){display:none!important}';document.head.appendChild(s);
      setInterval(()=>{document.querySelectorAll('.side-foot .caption').forEach((e)=>{const t=e.lastChild;
        if(/^Telegram/.test((e.textContent||'').trim())&&t&&t.nodeType===3&&t.textContent!=='demo'){e.firstElementChild?.classList.add('dot-ok');e.childNodes[1].textContent='Telegram: ';t.textContent='demo'}})},200)});`,
  });
}

function makeEval(cdp) {
  return async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
}

async function record(cdp) {
  const framesDir = path.join(WORK, "frames");
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  const frames = []; // { file, wall }
  let n = 0;
  cdp.on("Page.screencastFrame", (p) => {
    const file = path.join(framesDir, `f${String(++n).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(p.data, "base64"));
    frames.push({ file, wall: p.metadata?.timestamp ? p.metadata.timestamp * 1000 : Date.now() });
    void cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => null);
  });

  await setupPage(cdp);
  const evaluate = makeEval(cdp);
  await cdp.send("Page.navigate", { url: BASE + "/overview" });
  await sleep(2500);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: VW * DPR, maxHeight: VH * DPR, everyNthFrame: 1 });
  await sleep(800);

  const vars = {};
  if (REAL_DIR) vars.real = Object.fromEntries(JSON.parse(readFileSync(path.join(REAL_DIR, "real-run.json"), "utf8")).map((r) => [r.label, r]));
  const fill = (s) => s.replace(/\{([\w.-]+)\}/g, (_, k) => k.split(".").reduce((o, p) => o?.[p] ?? o?.data?.[p], vars) ?? "");
  const findJs = (sel, text) => `(() => {
    const re = ${text ? `new RegExp(${JSON.stringify(text)}, 'i')` : "null"};
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => {
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      return !re || re.test((e.innerText || e.textContent || '').trim()) || re.test(e.getAttribute('aria-label') || '');
    });
    if (!el) return null;
    let r = el.getBoundingClientRect();
    if (r.bottom > innerHeight - 40 || r.top < 60) { el.scrollIntoView({ block: 'center' }); r = el.getBoundingClientRect(); }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`;
  const find = async (sel, text, timeout = 15000) => {
    const t0 = Date.now();
    for (;;) {
      const r = await evaluate(findJs(sel, text));
      if (r) return r;
      if (Date.now() - t0 > timeout) throw new Error(`element not found: ${sel} ${text ?? ""}`);
      await sleep(200);
    }
  };
  const ripple = (x, y) =>
    evaluate(`(() => { const d = document.createElement('div'); d.setAttribute('popover','manual');
      d.style.cssText = 'position:fixed;inset:auto;margin:0;padding:0;border:0;left:${x - 26}px;top:${y - 26}px;width:52px;height:52px;border-radius:50%;background:rgba(29,78,216,.32);box-shadow:0 0 0 3px rgba(255,255,255,.95),0 0 0 6px rgba(29,78,216,.5);pointer-events:none;transition:transform .55s ease-out,opacity .55s ease-out;overflow:visible';
      document.body.appendChild(d); try { d.showPopover(); } catch (e) {}
      requestAnimationFrame(() => requestAnimationFrame(() => { d.style.transform = 'scale(1.8)'; d.style.opacity = '0'; }));
      setTimeout(() => d.remove(), 800); })()`);
  const mouse = (type, x, y, extra = {}) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "mouse", ...extra });
  const overlay = (id, css, html) =>
    evaluate(`(() => { let d = document.getElementById(${JSON.stringify(id)});
      if (${html === null ? "true" : "false"}) { if (d) { d.style.transition = 'opacity .25s'; d.style.opacity = '0'; setTimeout(() => d.remove(), 260); } return; }
      if (!d) { d = document.createElement('div'); d.id = ${JSON.stringify(id)}; d.setAttribute('popover','manual'); d.style.cssText = ${JSON.stringify(css)} + ';opacity:0;transition:opacity .25s'; document.body.appendChild(d); try { d.showPopover(); } catch (e) {} requestAnimationFrame(() => requestAnimationFrame(() => (d.style.opacity = '1'))); }
      d.innerHTML = ${JSON.stringify(html ?? "")}; })()`);

  let segStart = 0;
  const visible = (now = Date.now()) => (now - segStart) / 1000;

  async function act(a, seg, recording) {
    if (a.at !== undefined) {
      const target = seg.cues[a.at].start + (a.plus ?? 0);
      while (recording && visible() < target) await sleep(30);
    } else if (a.sleep !== undefined) await sleep(a.sleep * 1000);
    else if (a.nav) {
      await cdp.send("Page.navigate", { url: a.nav.startsWith("@real") ? REAL_BASE + fill(a.nav.slice(5)) : BASE + fill(a.nav) });
      await sleep(300);
      if (a.wait) await act({ wait: a.wait, timeout: a.timeout ?? 30000 }, seg, recording);
    } else if (a.tap) {
      const sel = fill(a.tap.sel);
      const r = await find(sel, a.tap.text);
      await sleep(120);
      const r2 = await find(sel, a.tap.text); // after a possible scrollIntoView
      if (!a.quiet) await ripple(r2.x, r2.y);
      if (!a.noClick) {
        await mouse("mouseMoved", r2.x, r2.y, { buttons: 0 });
        await mouse("mousePressed", r2.x, r2.y);
        await sleep(60);
        await mouse("mouseReleased", r2.x, r2.y);
      }
      void r;
      await sleep(250);
    } else if (a.wait) {
      const t0 = Date.now();
      for (;;) {
        if (await evaluate(`!!(${a.wait})`).catch(() => false)) break;
        if (Date.now() - t0 > (a.timeout ?? 15000)) throw new Error(`timeout in "${seg.id}": ${a.wait}`);
        await sleep(150);
      }
    } else if (a.scroll) {
      if (a.scroll.y !== undefined) await evaluate(`window.scrollTo({ top: ${a.scroll.y}, behavior: 'smooth' })`);
      else {
        await find(a.scroll.sel, a.scroll.text).catch(() => null);
        await evaluate(`(() => { const re = ${a.scroll.text ? `new RegExp(${JSON.stringify(a.scroll.text)}, 'i')` : "null"};
          const el = [...document.querySelectorAll(${JSON.stringify(a.scroll.sel)})].find((e) => !re || re.test((e.innerText || '').trim()));
          el?.scrollIntoView({ behavior: 'smooth', block: ${JSON.stringify(a.scroll.block ?? "center")} }); })()`);
      }
      await sleep((a.dur ?? 1) * 1000);
    } else if (a.key) {
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: a.key, code: a.key, windowsVirtualKeyCode: a.key === "Escape" ? 27 : 13 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: a.key, code: a.key, windowsVirtualKeyCode: a.key === "Escape" ? 27 : 13 });
      await sleep(250);
    } else if (a.zoom) {
      // punch in on an element for a.zoom.dur seconds: the window is applied at encode time (crop from the 1.4x layer)
      const r = await evaluate(`(() => { const re = ${a.zoom.text ? `new RegExp(${JSON.stringify(a.zoom.text)}, 'i')` : "null"};
        const el = [...document.querySelectorAll(${JSON.stringify(a.zoom.sel)})].find((e) => { const b = e.getBoundingClientRect(); return b.width > 1 && b.height > 1 && (!re || re.test(e.innerText || '')); });
        if (!el) return null; const b = el.getBoundingClientRect();
        return { x: Math.max(0, b.left), y: Math.max(0, b.top), w: Math.min(b.width, innerWidth), h: Math.min(b.height, innerHeight) }; })()`);
      if (!r) throw new Error(`zoom target not found: ${a.zoom.sel}`);
      const fit = Math.min(VW / r.w, VH / r.h) * 0.92;
      const z = Math.max(1.15, Math.min(a.zoom.z ?? 1.3, fit, HI));
      const t0 = visible();
      (seg.zooms ??= []).push({ a: t0, b: t0 + a.zoom.dur, cx: (r.x + r.w / 2) * K, cy: (r.y + r.h / 2) * K, z });
      log(`  zoom ${a.zoom.sel} x${z.toFixed(2)} ${t0.toFixed(1)}-${(t0 + a.zoom.dur).toFixed(1)}s`);
      await sleep(a.zoom.dur * 1000);
    } else if (a.mcp) {
      const toolArgs = typeof a.mcp.args === "function" ? a.mcp.args(vars) : a.mcp.args;
      vars[a.mcp.save] = await mcpCall(a.mcp.as, a.mcp.tool, toolArgs);
      vars[a.mcp.save].request_id = vars[a.mcp.save].data?.request_id;
    } else if (a.term !== undefined) {
      await overlay("demo-term", TERM_CSS, a.term === null ? null : termHtml(a.term(vars)));
    } else if (a.tg !== undefined) {
      if (a.tg === null) await overlay("demo-tg", TG_CSS, null);
      else {
        const v = vars[a.tg.from];
        const kind = a.tg.kind ?? "approval";
        let budget = null;
        if (kind === "approval") {
          const ov = await (await fetch(`${BASE}/api/overview`)).json();
          const ag = ov.agents.find((x) => x.name === a.tg.agent);
          budget = ag ? { monthSpentCents: ag.spent_cents, monthlyLimitCents: ag.limit_cents } : null;
        }
        const card = cardText(v.data, a.tg.agent, kind, budget);
        vars[`${a.tg.from}_card`] = card;
        const title = kind === "blocked" ? "Telegram alert · text sent by the Reins bot" : "Telegram approval card · text sent by the Reins bot";
        await overlay("demo-tg", TG_CSS, tgHtml(title, card));
      }
    } else if (a.api) {
      const res = await fetch(BASE + a.api.path, { method: a.api.method, headers: { "content-type": "application/json" }, body: a.api.body ? JSON.stringify(a.api.body) : undefined });
      log(`  ${a.api.method} ${a.api.path} -> ${res.status} ${(await res.text()).slice(0, 160)}`);
    } else if (a.save) {
      vars[a.save.name] = await evaluate(a.save.js);
    } else if (a.cmdk !== undefined) {
      // real keyboard input: Cmd+K opens the palette, the text is typed key by key, Enter opens the first hit
      const key = (type, k, extra = {}) => cdp.send("Input.dispatchKeyEvent", { type, key: k, ...extra });
      await key("rawKeyDown", "Meta", { code: "MetaLeft", windowsVirtualKeyCode: 91, modifiers: 4 });
      await key("rawKeyDown", "k", { code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 4 });
      await key("keyUp", "k", { code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 4 });
      await key("keyUp", "Meta", { code: "MetaLeft", windowsVirtualKeyCode: 91 });
      await act({ wait: "!!document.querySelector('.cmdk-input') && document.activeElement === document.querySelector('.cmdk-input')", timeout: 5000 }, seg, recording);
      await sleep(500);
      for (const ch of a.cmdk) {
        await key("keyDown", ch, { text: ch });
        await key("keyUp", ch);
        await sleep(130);
      }
      await act({ wait: "document.querySelector('.cmdk-item')", timeout: 8000 }, seg, recording);
      await sleep(900);
      await key("rawKeyDown", "Enter", { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
      await key("keyUp", "Enter", { code: "Enter", windowsVirtualKeyCode: 13 });
      await sleep(400);
    } else throw new Error(`unknown action ${JSON.stringify(a)}`);
  }

  for (const seg of SEGMENTS) {
    for (const a of seg.prep ?? []) await act(a, seg, false);
    await sleep(300);
    segStart = Date.now();
    const seed = frames.at(-1);
    for (const a of seg.actions) await act(a, seg, true);
    const target = seg.audioDur;
    if (visible() > target + 0.05) log(`  WARN ${seg.id}: actions took ${visible().toFixed(2)}s > narration ${target.toFixed(2)}s (silence padded)`);
    while (visible() < target) await sleep(30);
    const end = Date.now();
    seg.duration = Math.max(target, visible(end));
    const segFrames = [];
    if (seed) segFrames.push({ file: seed.file, v: 0 });
    for (const f of frames) if (f.wall >= segStart && f.wall <= end) segFrames.push({ file: f.file, v: Math.max(0, visible(f.wall)) });
    seg.frames = segFrames;
    log(`segment ${seg.id}: ${seg.duration.toFixed(2)}s, ${segFrames.length} frames`);
  }
  await cdp.send("Page.stopScreencast");
  writeFileSync(path.join(WORK, "mcp-calls.json"), JSON.stringify(mcpLog, null, 2));
  return vars;
}

/* ── 5. clean gallery screenshots (1920x1080, final DB state) ──────────────── */
async function gallery(cdp, vars) {
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  const evaluate = makeEval(cdp);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 810, deviceScaleFactor: 4 / 3, mobile: false });
  const agents = (await (await fetch(`${BASE}/api/agents`)).json()).agents;
  const scout = agents.find((a) => a.name === "Research Scout")?.id ?? "";
  const pages = [
    ["02-overview", "/overview", "!document.querySelector('.skeleton') && document.body.innerText.includes('AI weekly summary')", 0],
    ["03-overview-summary", "/overview", "!document.querySelector('.skeleton') && document.body.innerText.includes('AI weekly summary')", 520],
    ["07-ledger-blocked-detail", `/ledger/${vars.a3?.data?.display_id ?? ""}`, "!!document.querySelector('.drawer .risk-card') && document.body.innerText.includes('Hard rules')", 0],
    ["08-ledger-paid-detail", "/ledger", "!!document.querySelector('.ag-row')", 0, vars.a2?.request_id],
    ["09-receipt", `/receipts/${vars.a2?.request_id ?? ""}`, "document.body.innerText.includes('59.00')", 0],
    ["10-agents-mandate", `/agents?agent=${scout}`, "document.body.innerText.includes('v3 · current')", 0],
  ];
  for (const [name, p, wait, y, expand] of pages) {
    await cdp.send("Page.navigate", { url: BASE + p });
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && !(await evaluate(`!!(${wait})`).catch(() => false))) await sleep(200);
    await sleep(1200);
    if (expand) {
      // show only Research Scout's rows, then open the request's detail row
      await evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Research Scout')?.click()`);
      await sleep(1000);
      await evaluate(`document.querySelector('[row-id="${expand}"] .ag-group-contracted')?.click()`);
      await sleep(1200);
    }
    if (y) {
      await evaluate(`window.scrollTo(0, ${y})`);
      await sleep(500);
    } else await evaluate(`(() => { const d = document.querySelector('.ledger-detail'); if (d) d.scrollIntoView({ block: 'center' }); })()`);
    await sleep(400);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(shot.data, "base64"));
  }
  // an open approval for the inbox shot (a $40 Vercel upgrade from the DevOps agent: over its $30 limit, inside its caps)
  await mcpCall("Claude Code – DevOps", "request_purchase", { merchant: "vercel.com", amount: "40.00", items: "Vercel Pro, 2 extra seats", reason: "Two contractors join for launch week", category: "infrastructure", client_request_id: "gallery-vercel-seats" });
  const shoot = async (name, p, wait) => {
    await cdp.send("Page.navigate", { url: BASE + p });
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && !(await evaluate(`!!(${wait})`).catch(() => false))) await sleep(200);
    await sleep(1500);
  };
  const snap = async (name) => writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await shoot("05-inbox", "/inbox", "document.body.innerText.includes('Vercel Pro')");
  await snap("05-inbox");
  // command palette (real Cmd+K and typing)
  await shoot("11-command-palette", "/overview", "!document.querySelector('.skeleton') && document.body.innerText.includes('AI weekly summary')");
  const key = (type, k, extra = {}) => cdp.send("Input.dispatchKeyEvent", { type, key: k, ...extra });
  await key("rawKeyDown", "k", { code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 4 });
  await key("keyUp", "k", { code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 4 });
  await sleep(600);
  for (const ch of "statista") {
    await key("keyDown", ch, { text: ch });
    await key("keyUp", ch);
    await sleep(60);
  }
  await sleep(1200);
  await snap("11-command-palette");
  // phone width ledger
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await shoot("12-mobile-ledger", "/ledger", "!!document.querySelector('.ag-row') || document.body.innerText.includes('Paid')");
  await snap("12-mobile-ledger");
  log(`gallery: ${pages.length + 3} page screenshots in ${SHOTS}`);
}

/* ── 6. encode ─────────────────────────────────────────────────────────────── */
function concatList(file, items, total) {
  const lines = [];
  items.forEach((it, i) => {
    const end = i + 1 < items.length ? items[i + 1].start : total;
    const d = end - it.start;
    if (d <= 0) return;
    lines.push(`file '${it.file}'`, `duration ${d.toFixed(4)}`);
  });
  lines.push(`file '${items.at(-1).file}'`);
  writeFileSync(file, lines.join("\n"));
}

/**
 * Screen layer: scaled once to 1.4x, then zoompan crops it. Each zoom window eases in and out (0.4 s smoothstep);
 * the view centre moves from the screen centre to the target while it zooms, so the card grows in place.
 */
function zoomFilter(zooms) {
  const even = (n) => 2 * Math.round(n / 2);
  if (!zooms.length) return `[1:v]scale=${SCR_W}:${SCR_H}:flags=lanczos,setsar=1,fps=${FPS}[scr]`;
  const R = 0.4;
  const env = zooms.map((zm) => {
    const e = `clip(min((it-${zm.a.toFixed(3)})/${R},(${zm.b.toFixed(3)}-it)/${R}),0,1)`;
    return `(${e}*${e}*(3-2*${e}))`;
  });
  const zExpr = `1+${zooms.map((zm, i) => `${(zm.z - 1).toFixed(3)}*${env[i]}`).join("+")}`;
  const cx = `${SCR_W / 2}+${zooms.map((zm, i) => `${env[i]}*${(zm.cx - SCR_W / 2).toFixed(1)}`).join("+")}`;
  const cy = `${SCR_H / 2}+${zooms.map((zm, i) => `${env[i]}*${(zm.cy - SCR_H / 2).toFixed(1)}`).join("+")}`;
  return [
    `[1:v]scale=${even(SCR_W * HI)}:${even(SCR_H * HI)}:flags=lanczos,setsar=1,fps=${FPS}[hi]`,
    `[hi]zoompan=z='${zExpr}':x='clip((${cx})*${HI}-(iw/zoom)/2,0,iw-iw/zoom)':y='clip((${cy})*${HI}-(ih/zoom)/2,0,ih-ih/zoom)':d=1:s=${SCR_W}x${SCR_H}:fps=${FPS}[scr]`,
  ].join(";");
}

function encode() {
  const dir = path.join(WORK, "segments");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const outs = [];
  let t0 = 0;
  for (const seg of SEGMENTS) {
    const dur = seg.duration;
    const bgList = path.join(dir, `${seg.id}-stage.txt`);
    concatList(bgList, seg.stage.map((f) => ({ file: f.png, start: f.start })), dur);
    const out = path.join(dir, `${seg.id}.mp4`);
    const common = ["-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3), "-r", String(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", out];
    if (seg.card) {
      const filter = [`[0:v]format=rgba,fps=${FPS},format=yuv420p[v]`, `[1:a]apad[a]`].join(";");
      run(FFMPEG, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", bgList, "-i", seg.audio, "-filter_complex", filter, ...common]);
    } else {
      const fr = [...seg.frames].sort((a, b) => a.v - b.v);
      const ticks = [];
      let j = 0;
      let cur = fr[0];
      for (let i = 0; i < Math.round(dur * FPS); i++) {
        const t = i / FPS;
        while (j < fr.length && fr[j].v <= t) cur = fr[j++];
        if (!ticks.length || ticks.at(-1).file !== cur.file) ticks.push({ file: cur.file, start: t });
      }
      const scrList = path.join(dir, `${seg.id}-screen.txt`);
      concatList(scrList, ticks, dur);
      const filter = [
        `color=c=0xeef2ff:s=${W}x${H}:r=${FPS}:d=${dur.toFixed(3)}[base]`,
        zoomFilter(seg.zooms ?? []),
        `[base][scr]overlay=${SCR_X}:${SCR_Y}:eof_action=repeat[b1]`,
        `[0:v]format=rgba,fps=${FPS}[stage]`,
        `[b1][stage]overlay=0:0:eof_action=repeat,format=yuv420p[v]`,
        `[2:a]apad[a]`,
      ].join(";");
      run(FFMPEG, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", bgList, "-f", "concat", "-safe", "0", "-i", scrList, "-i", seg.audio, "-filter_complex", filter, ...common]);
    }
    seg.start = t0;
    t0 += dur;
    outs.push(out);
    log(`encoded ${seg.id} (${dur.toFixed(2)}s)`);
  }
  mkdirSync(path.dirname(OUT), { recursive: true });
  const list = path.join(dir, "all.txt");
  writeFileSync(list, outs.map((o) => `file '${o}'`).join("\n"));
  run(FFMPEG, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", OUT]);
  const total = probe(OUT);
  log(`wrote ${OUT} (${total.toFixed(2)}s)`);
  const frame = (t, f) => run(FFMPEG, ["-y", "-v", "error", "-ss", t.toFixed(2), "-i", OUT, "-frames:v", "1", f]);
  if (STILLS > 0) {
    const sdir = path.join(WORK, "stills");
    rmSync(sdir, { recursive: true, force: true });
    mkdirSync(sdir, { recursive: true });
    for (let i = 0; i < STILLS; i++) frame((total * (i + 0.5)) / STILLS, path.join(sdir, `still-${i + 1}.png`));
    log(`stills: ${sdir}`);
  }
  // video frames for the gallery: title card, the live MCP exchange in each act
  const at = (id, cue, plus = 0) => {
    const s = SEGMENTS.find((x) => x.id === id);
    return s.start + Math.min(s.cues[cue].start + plus, s.duration - 0.1);
  };
  mkdirSync(SHOTS, { recursive: true });
  frame(at("close", 0, 1.0), path.join(SHOTS, "01-title.png"));
  frame(at("ask", 1, 2.0), path.join(SHOTS, "04-agent-request-over-mcp.png"));
  frame(at("deny", 1, 2.2), path.join(SHOTS, "06-prompt-injection-blocked.png"));
  return total;
}

/* ── main ──────────────────────────────────────────────────────────────────── */
try {
  mkdirSync(WORK, { recursive: true });
  if (!REAL_DIR) SEGMENTS.splice(0, SEGMENTS.length, ...SEGMENTS.filter((s) => !s.needsReal)); // the real-run beat needs --real
  log(`work=${WORK} out=${OUT}`);
  buildAudio();
  const cdp = await launchChrome();
  await renderStage(cdp);
  prepareDb();
  await startServers();
  const vars = await record(cdp);
  await gallery(cdp, vars);
  const total = encode();
  writeFileSync(
    path.join(WORK, "summary.json"),
    JSON.stringify({ out: OUT, totalSeconds: total, segments: SEGMENTS.map((s) => ({ id: s.id, start: s.start, seconds: s.duration, cues: s.cues.map((c) => c.text) })) }, null, 2),
  );
  log(`done: ${total.toFixed(1)}s · ${SEGMENTS.map((s) => `${s.id} ${s.duration.toFixed(1)}`).join(" · ")}`);
  await shutdown(0);
} catch (e) {
  console.error("[rec] FAILED:", e.message);
  await shutdown(1);
}
