#!/usr/bin/env node
/**
 * REAL-mode demo video recorder for Reins (adapted from scripts/demo/record-video.mjs, which records an offline take).
 *
 *   node scripts/demo/record-video-real.mjs --work <scratch dir> --session .local/video/claude-session-r0147.jsonl \
 *        --out .local/video/reins-demo-v2.mp4 [--port 3927] [--no-build]
 *
 * What is real here:
 *  - local scenes: `next start` (production build in apps/web/.next-video2) on a fresh scratch DB seeded with
 *    scripts/seed.ts (the recorded real sandbox run), started with `node --env-file=<repo>/.env` plus overrides:
 *    PAYPAL_ENV=sandbox, PAYPAL_PAYMENT_MODE=treasury, TREASURY_PAYEE_EMAIL from PAYPAL_SANDBOX_BUYER_EMAIL (copied in
 *    process by scripts/demo/real-env-preload.mjs, never printed), REINS_PUBLIC_DEMO=1 and the rest of render.yaml's
 *    public-demo settings, Telegram off. Claude audits use ANTHROPIC_API_KEY from that env file; payouts are real PayPal
 *    sandbox Payouts. Webhooks cannot reach localhost, so the server's own sweep (REINS_EXPIRY_SWEEP_MS=5000; it asks
 *    PayPal about payouts older than 2 minutes) settles them. Values from the env file are never logged.
 *  - the terminal scene replays the stream-json log of a real `claude -p` session against the hosted MCP
 *    (scripts/demo/term-replay.mjs); the receipt shown after it is the hosted page for that same request.
 * Waits for real work (Claude audit, PayPal payout) are fast-forwarded ("warp") with an in-page "sped up" tag.
 * Narration: OpenAI TTS (gpt-4o-mini-tts, voice coral), one request per line, cached by text hash in <work>/tts.
 * Needs: Google Chrome, ffmpeg/ffprobe, sqlite3, OPENAI_API_KEY in the environment (never printed).
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SEGMENTS } from "./video-shots-real.mjs";
import { sessionEvents, termHtml } from "./term-replay.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]] : acc), []),
);
const PORT = Number(args.port ?? 3927);
const BASE = `http://localhost:${PORT}`;
if (!args.work) throw new Error("--work <scratch dir> is required");
const WORK = path.resolve(args.work);
const OUT = path.resolve(args.out ?? path.join(ROOT, ".local/video/reins-demo-v4.mp4"));
const SESSION = path.resolve(args.session ?? path.join(ROOT, ".local/video/claude-session-hosted-v4.jsonl"));
const DB_FILE = path.join(WORK, "reins-video.db");
const DIST = ".next-video2";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FFMPEG = existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg";
const FFPROBE = existsSync("/opt/homebrew/bin/ffprobe") ? "/opt/homebrew/bin/ffprobe" : "ffprobe";
const TZ = "America/Los_Angeles";
const MCP_URL = "https://reins-mcp.onrender.com/mcp";
const SETUP_CMD = `claude mcp add --transport http reins ${MCP_URL}`;
const RUN_CMD = `claude -p "Renew our project domain: buy reins-demo.dev for 1 year at namecheap.com for $12.98 through Reins. Check the mandate first, request the purchase, then check its status. Finish with one short line: status, request id and PayPal id." --mcp-config mcp.json --strict-mcp-config --model haiku --allowedTools "mcp__reins" --output-format stream-json --verbose`;
const TTS_MODEL = "gpt-4o-mini-tts";
const TTS_VOICE = "coral";
const TTS_INSTRUCTIONS =
  "Voice: warm, calm and confident, like a product engineer giving a clear demo to a jury. Pace: medium-fast and steady, no long pauses. Tone: plain and sincere, no hype, no sales voice. Pronounce PayPal, Claude, MCP and AG Grid clearly.";

// Layout (1920x1080): the dashboard fills a 1766x1030 window; captions and labels are overlays.
const W = 1920, H = 1080, FPS = 30;
const VW = 1280, VH = 746, DPR = 2; // CSS viewport; 2x frames (2560 px) leave room for 1.4x punch-ins
const SCR_W = 1766, SCR_H = 1030, SCR_X = 77, SCR_Y = 12;
const K = SCR_W / VW; // CSS px -> output px (1.38)
const HI = 1.4;
const LEAD = 0.4, GAP = 0.25, TAIL = 0.6;
const TEMPO = 1.09; // the TTS voice reads ~2.3 words/s; 1.09x keeps it natural and fits 2:30
const L3_TO = 1.8;
const SIDEBAR = 216; // CSS width of the app sidebar at 1280 px

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

/* ── 1. narration audio: OpenAI TTS, one request per line, cached by hash ─────── */
const ttsStats = { requests: 0, cached: 0 };
async function tts(text, file) {
  if (existsSync(file)) {
    ttsStats.cached++;
    return;
  }
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  ttsStats.requests++;
  if (ttsStats.requests > 45) throw new Error("TTS request budget exceeded");
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, instructions: TTS_INSTRUCTIONS, response_format: "wav" }),
  });
  if (!res.ok) throw new Error(`TTS failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

const silenceWav = (sec, f) => run(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", Math.max(0.001, sec).toFixed(3), "-c:a", "pcm_s16le", f]);

/** TTS per line (trimmed, 1.09x); card segments get their cue times here, screen segments while recording ({ say }). */
async function buildAudio() {
  const dir = path.join(WORK, "audio");
  const cache = path.join(WORK, "tts");
  mkdirSync(dir, { recursive: true });
  mkdirSync(cache, { recursive: true });
  for (const seg of SEGMENTS) {
    seg.lineFiles = [];
    seg.lineDur = [];
    for (const [i, line] of seg.lines.entries()) {
      const say = lineSay(line);
      const hash = createHash("sha256").update(`${TTS_MODEL}|${TTS_VOICE}|${TTS_INSTRUCTIONS}|${say}`).digest("hex").slice(0, 16);
      const raw = path.join(cache, `${hash}.wav`);
      await tts(say, raw);
      const wav = path.join(dir, `${seg.id}-${i}.wav`);
      run(FFMPEG, ["-y", "-v", "error", "-i", raw, "-af", `silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.03,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08,areverse,atempo=${seg.tempo ?? TEMPO}`, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
      seg.lineFiles.push(wav);
      seg.lineDur.push(probe(wav));
    }
    if (seg.card) {
      let t = LEAD;
      seg.cues = seg.lineDur.map((d, i) => {
        const c = { start: t, end: t + d, text: lineText(seg.lines[i]) };
        t += d + (seg.gaps?.[i] ?? GAP);
        return c;
      });
      seg.duration = seg.cues.at(-1).end + (seg.tail ?? TAIL);
    }
    log(`audio ${seg.id}: ${seg.lineDur.reduce((x, y) => x + y, 0).toFixed(2)}s speech (${seg.lineDur.map((d) => d.toFixed(1)).join(", ")}), ${seg.lines.map(lineText).join(" ").split(/\s+/).length} words`);
  }
  log(`TTS: ${ttsStats.requests} new requests, ${ttsStats.cached} cached`);
}

/** Segment narration track: each line placed at its cue start, silence between, padded to the segment duration. */
function segAudio(seg) {
  const dir = path.join(WORK, "audio");
  const parts = [];
  let t = 0;
  seg.cues.forEach((c, i) => {
    const g = path.join(dir, `${seg.id}-sil${i}.wav`);
    silenceWav(c.start - t, g);
    parts.push(g, seg.lineFiles[i]);
    t = c.start + seg.lineDur[i];
  });
  const tail = path.join(dir, `${seg.id}-siltail.wav`);
  silenceWav(seg.duration - t + 0.05, tail);
  parts.push(tail);
  const list = path.join(dir, `${seg.id}-list.txt`);
  writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
  seg.audio = path.join(dir, `${seg.id}.wav`);
  run(FFMPEG, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c:a", "pcm_s16le", seg.audio]);
}

/* ── CDP plumbing ──────────────────────────────────────────────────────────── */
async function launchChrome() {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = path.join(WORK, "chrome-profile");
  rmSync(profile, { recursive: true, force: true });
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
const SOURCE = {
  hosted: "Hosted demo: reins-web.onrender.com and reins-mcp.onrender.com · payouts go to a sandbox test payee",
  local: "Local server, same code in real mode · payouts go to a sandbox test payee · scratch database",
  card: "",
};
const CORNER = "PayPal sandbox · real Claude audits";

const HOOK_SRC = "Stripe newsroom, 2026-09-08 (Meta Muse + Link) · PayPal developer blog, 2025-09-16 (AP2) · PayPal newsroom, 2025-10-28 (Agentic Commerce Services)";

function cardHtml(seg, ci) {
  const sub = esc(seg.cues[ci].text);
  const shell = (inner) => `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;font-family:${FONT};-webkit-font-smoothing:antialiased}
    body{background:radial-gradient(1200px 700px at 30% 20%,#1e3a8a 0%,#0b1736 60%,#081028 100%);color:#fff}
    .wrap{position:absolute;left:170px;right:170px;top:120px;bottom:230px;display:flex;flex-direction:column;justify-content:center;gap:34px}
    .brand{display:flex;align-items:center;gap:18px;font-size:38px;font-weight:800;letter-spacing:-.01em}
    .brand i{display:block;width:44px;height:44px;border-radius:12px;background:#3b82f6}
    h1{margin:0;font-size:104px;line-height:1.02;font-weight:800;letter-spacing:-.03em}
    .tag{font-size:42px;line-height:1.25;font-weight:600;color:#dbe6ff;max-width:1500px}
    .row{display:flex;gap:16px;flex-wrap:wrap}
    .pill{border:2px solid #3b5bab;border-radius:999px;padding:11px 24px;font-size:28px;font-weight:600;color:#dbe6ff}
    .who{display:grid;grid-template-columns:1fr 1fr;gap:20px}
    .who div{border:2px solid #2c4485;border-radius:18px;padding:18px 24px;font-size:28px;line-height:1.3;color:#dbe6ff}
    .who b{display:block;color:#fff;font-size:30px;margin-bottom:4px}
    .url{font-size:40px;font-weight:700;color:#93c5fd;font-family:Menlo,monospace}
    .facts{display:flex;flex-direction:column;gap:14px}
    .facts div{font-size:38px;line-height:1.25;font-weight:600;color:#dbe6ff}
    .facts span{display:inline-block;min-width:270px;margin-right:22px;color:#93c5fd;font-family:Menlo,monospace;font-size:32px}
    .cta{font-size:96px;line-height:1.05;font-weight:800;letter-spacing:-.02em;color:#93c5fd;font-family:Menlo,monospace}
    .src{position:absolute;left:170px;right:170px;bottom:44px;font-size:20px;color:#8ea3d1}
    .sub{position:absolute;left:120px;right:120px;bottom:96px;display:flex;justify-content:center}
    .sub span{max-width:1560px;text-align:center;font-size:36px;line-height:1.3;font-weight:600;color:#fff;background:rgba(5,12,32,.6);border-radius:14px;padding:10px 26px 12px}
    </style></head><body>${inner}<div class="sub"><span>${sub}</span></div></body></html>`;
  if (seg.card === "hook") {
    const head = ["$450 logo, no questions asked?", "Agents are getting wallets.", "Agents are getting wallets.", "Who sets the limit?"][ci];
    const facts = ci === 1 || ci === 2
      ? `<div class="facts"><div><span>Sept 8, 2026</span>Meta's Muse can pay through Stripe Link (US)</div>${ci === 2 ? `<div><span>Sept 16, 2025</span>PayPal supports Google's AP2</div><div><span>Oct 28, 2025</span>PayPal launches Agentic Commerce Services</div>` : ""}</div>`
      : "";
    return shell(`<div class="wrap"><div class="brand"><i></i>Reins</div><h1>${esc(head)}</h1>${facts}${ci === 3 ? `<div class="tag">Spending controls for AI agents on PayPal.</div>` : ""}</div>${ci === 1 || ci === 2 ? `<div class="src">${esc(HOOK_SRC)}</div>` : ""}`);
  }
  // close: one card, everything visible for the whole card; the /try URL is the call to action
  return shell(`<div class="wrap" style="top:70px;bottom:200px;gap:26px"><div class="brand"><i></i>Reins · Hold the reins on AI spending.</div>
    <div class="cta">reins-web.onrender.com/try</div>
    <div class="who"><div><b>Companies</b>Each agent gets a card with a limit and an approval line.</div><div><b>Solo founders</b>Agents run on auto-approve, inside a mandate.</div></div>
    <div class="row"><span class="pill">Payouts</span><span class="pill">Transaction Search</span><span class="pill">Orders v2 + Vault</span><span class="pill">Webhooks</span><span class="pill">Open-source MCP server</span></div>
    <div class="url" style="font-size:40px;color:#c7d4f3">github.com/sh0sub/reins</div></div>`);
}

function stageHtml(seg, { text, l3, big, top }) {
  const bottom = H - (SCR_Y + SCR_H);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden;font-family:${FONT};color:#0f172a;-webkit-font-smoothing:antialiased}
  .hole{position:absolute;left:${SCR_X}px;top:${SCR_Y}px;width:${SCR_W}px;height:${SCR_H}px;border-radius:16px;box-shadow:0 0 0 1px #c7d2fe,0 18px 48px 0 rgba(30,58,138,.16),0 0 0 3000px #eef2ff}
  .foot{position:absolute;left:${SCR_X + 4}px;width:${SCR_W - 8}px;bottom:0;height:${bottom}px;display:flex;align-items:center;justify-content:space-between;gap:24px;font-size:16px;color:#475569}
  .foot b{display:flex;align-items:center;gap:8px;color:#0b2a6f;font-size:17px;font-weight:800}
  .foot b i{display:block;width:16px;height:16px;border-radius:5px;background:#1d4ed8}
  .foot .c{display:flex;align-items:center;gap:8px;font-weight:700;color:#14532d}
  .foot .c i{display:block;width:9px;height:9px;border-radius:50%;background:#16a34a}
  .l3{position:absolute;left:${SCR_X + 36}px;bottom:${bottom + 128}px;max-width:900px;background:rgba(255,255,255,.97);border-left:7px solid #1d4ed8;border-radius:14px;padding:16px 26px 18px 22px;box-shadow:0 14px 40px rgba(15,23,42,.28)}
  .l3 .k{font-size:19px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#1d4ed8}
  .l3 h1{margin:2px 0 8px;font-size:42px;line-height:1.1;font-weight:800;letter-spacing:-.015em}
  .l3 .c{display:inline-block;background:#dbe4ff;color:#1e3a8a;border-radius:999px;padding:7px 16px;font-size:18px;font-weight:700}
  .sub{position:absolute;left:${SCR_X}px;width:${SCR_W}px;bottom:${bottom + 22}px;display:flex;justify-content:center;pointer-events:none}
  .sub span{max-width:1500px;text-align:center;font-size:32px;line-height:1.3;font-weight:600;color:#fff;background:rgba(11,23,54,.88);border-radius:14px;padding:10px 26px 12px;box-shadow:0 10px 30px rgba(15,23,42,.3)}
  .big{position:absolute;left:${SCR_X}px;width:${SCR_W}px;top:${SCR_Y + SCR_H / 2 - 110}px;height:190px;display:flex;align-items:center;justify-content:center;background:rgba(11,23,54,.86)}
  .big span{font-size:76px;font-weight:800;letter-spacing:-.02em;color:#fff}
  </style></head><body>
  <div class="hole"></div>
  <div class="foot"><b><i></i>Reins</b><span>${esc(SOURCE[seg.source ?? "card"])}</span><span class="c"${seg.corner ? ' style="color:#92400e"' : ""}><i${seg.corner ? ' style="background:#f59e0b"' : ""}></i>${esc(seg.corner ?? CORNER)}</span></div>
  ${l3 ? `<div class="l3"><div class="k">${esc(seg.kicker)}</div><h1>${esc(seg.heading)}</h1><span class="c">${esc(seg.chip)}</span></div>` : ""}
  ${big ? `<div class="big"><span>${esc(text)}</span></div>` : text ? `<div class="sub"${top ? ` style="bottom:auto;top:${SCR_Y + 70}px"` : ""}><span>${esc(text)}</span></div>` : ""}
  </body></html>`;
}

async function renderStage(cdp) {
  const dir = path.join(WORK, "stage");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  let n = 0;
  for (const seg of SEGMENTS) {
    seg.stage = [];
    const shoot = async (html, start) => {
      const f = path.join(dir, `${seg.id}-${++n}.html`);
      const png = path.join(dir, `${seg.id}-${n}.png`);
      writeFileSync(f, html);
      await cdp.send("Page.navigate", { url: `file://${f}` });
      await sleep(220);
      writeFileSync(png, Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
      seg.stage.push({ png, start });
    };
    if (seg.card) {
      for (const [ci, cue] of seg.cues.entries()) await shoot(cardHtml(seg, ci), ci === 0 ? 0 : cue.start);
      continue;
    }
    // a caption shows only while its line is spoken; the lower third for the first L3_TO seconds
    const times = [...new Set([0, L3_TO, ...seg.cues.flatMap((c) => [c.start, c.end])].map((t) => +t.toFixed(3)))].filter((t) => t < seg.duration).sort((x, y) => x - y);
    let prev = "";
    for (const t of times) {
      const ci = seg.cues.findIndex((c) => t >= c.start - 0.001 && t < c.end - 0.001);
      const cue = seg.cues[ci];
      const state = { text: cue?.text, top: cue?.top, l3: t < L3_TO, big: !!cue && !!seg.bigLast && ci === seg.cues.length - 1 };
      const key = JSON.stringify(state);
      if (key === prev) continue;
      prev = key;
      await shoot(stageHtml(seg, state), t);
    }
  }
  await cdp.send("Emulation.setDefaultBackgroundColorOverride", {});
  log(`stage graphics: ${SEGMENTS.reduce((k, x) => k + x.stage.length, 0)} PNGs`);
}

/* ── 3. scratch DB + server (real mode) ────────────────────────────────────── */
function realEnv() {
  // overrides for the real-mode server; everything else (PayPal, Anthropic keys) comes from --env-file inside the child
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "en_US.UTF-8",
    PAYPAL_ENV: "sandbox",
    PAYPAL_PAYMENT_MODE: "treasury",
    PAYPAL_VAULT_STORED_CREDENTIAL: "0",
    DATABASE_URL: `file:${DB_FILE}`,
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_MODE: "off",
    TELEGRAM_BOT_USERNAME: "ReinsApproveBot",
    REINS_TELEGRAM_LOG: "0",
    REINS_PUBLIC_DEMO: "1",
    REINS_TIMEZONE: "Asia/Seoul",
    REINS_QUIET_HOURS: "off",
    REINS_APPROVAL_TTL_MINUTES: "10080",
    REINS_EXPLAIN_DENIALS: "1",
    REINS_EXPIRY_SWEEP_MS: "5000",
    REINS_KEEPWARM_URL: "",
    PUBLIC_BASE_URL: BASE,
    REINS_API_URL: BASE,
    NEXT_TELEMETRY_DISABLED: "1",
    REINS_NEXT_DIST_DIR: DIST,
    NODE_ENV: "production",
  };
}
const NODE_REAL = ["--env-file=" + path.join(ROOT, ".env"), "--import", path.join(ROOT, "scripts/demo/real-env-preload.mjs")];

async function portFree(port) {
  try {
    await fetch(`http://localhost:${port}/`);
    return false;
  } catch {
    return true;
  }
}

function prepareDb() {
  if (!DB_FILE.startsWith(WORK + path.sep)) throw new Error("DB outside work dir");
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, `${DB_FILE}-journal`]) rmSync(f, { force: true });
  const env = { ...realEnv(), NODE_ENV: "development" };
  const out = run(process.execPath, [...NODE_REAL, "--import", "tsx", "scripts/seed.ts", "--db", DB_FILE], { cwd: ROOT, env });
  log(out.trim().split("\n").slice(0, 2).join(" | "));
  const ws = run("/usr/bin/sqlite3", [DB_FILE, "select paypal_env || '|' || payment_mode from workspace"]).trim();
  if (ws !== "sandbox|treasury") throw new Error(`seeded workspace is not sandbox|treasury: ${ws}`);
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

async function startServer() {
  if (!(await portFree(PORT))) throw new Error(`port ${PORT} is already in use`);
  const web = path.join(ROOT, "apps/web");
  if (!args["no-build"] || !existsSync(path.join(web, DIST, "BUILD_ID"))) {
    log("next build ->", DIST);
    run(process.execPath, [...NODE_REAL, "node_modules/next/dist/bin/next", "build"], { cwd: web, env: realEnv() });
  }
  const webLog = spawnServer("web", process.execPath, [...NODE_REAL, "node_modules/next/dist/bin/next", "start", "-p", String(PORT)], web, realEnv());
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* booting */
    }
    await sleep(500);
  }
  const ws = await (await fetch(`${BASE}/api/workspace`)).json();
  if (ws.paypal_env !== "sandbox" || ws.payment_mode !== "treasury" || !ws.public_demo) throw new Error(`server is not in real sandbox treasury public-demo mode: ${JSON.stringify(ws)}`);
  log(`web on ${BASE} (log ${webLog}); sandbox + treasury + public demo`);
  for (const p of ["/overview", "/inbox", "/ledger", "/try", "/api/ledger", "/api/overview"]) await fetch(BASE + p).catch(() => null);
}

function cardText(view, agentName, budget) {
  const f = path.join(WORK, "card-input.json");
  // ttlMinutes 30 = the product default (REINS_APPROVAL_TTL_MINUTES unset); the public demo raises it to 7 days
  writeFileSync(f, JSON.stringify({ kind: "approval", view, agentName, budget, ttlMinutes: 30 }));
  return JSON.parse(run(path.join(ROOT, "node_modules/.bin/tsx"), ["scripts/demo/card-text.ts", f], { cwd: ROOT }));
}

/* ── in-page overlays ──────────────────────────────────────────────────────── */
const TG_CSS = `position:fixed;inset:auto;margin:0;right:24px;top:72px;width:520px;padding:0;border:1px solid #cbd5e1;border-radius:14px;background:#ffffff;color:#0f172a;box-shadow:0 18px 48px rgba(15,23,42,.3);font:15px/1.45 -apple-system,Helvetica,Arial,sans-serif;z-index:2147483647`;
const tgHtml = (title, card) => `<style>
  #demo-tg .h{padding:11px 16px;border-bottom:1px solid #e2e8f0;font-weight:700;font-size:13px;letter-spacing:.03em;color:#475569}
  #demo-tg pre{margin:0;padding:12px 16px 4px;white-space:pre-wrap;font:14px/1.45 Menlo,Monaco,monospace;color:#0f172a}
  #demo-tg .b{display:flex;flex-wrap:wrap;gap:7px;padding:8px 16px 14px}
  #demo-tg .b span{border:1px solid #94a3b8;border-radius:8px;padding:5px 11px;font-size:13px;font-weight:600;color:#1e293b}
  </style><div class="h">${esc(title)}</div><pre>${esc(card.text)}</pre>${card.buttons.length ? `<div class="b">${card.buttons.flat().map((b) => `<span>${esc(b)}</span>`).join("")}</div>` : ""}`;
const TAG_CSS = `position:fixed;inset:auto;margin:0;left:50%;top:70px;transform:translateX(-50%);padding:10px 20px;border:1px solid #f59e0b;border-radius:999px;background:#fef3c7;color:#92400e;font:800 17px/1 -apple-system,Helvetica,Arial,sans-serif;letter-spacing:.02em;box-shadow:0 8px 24px rgba(15,23,42,.22);z-index:2147483647`;

/* ── 4. recording ──────────────────────────────────────────────────────────── */
async function setupPage(cdp) {
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: DPR, mobile: false });
  await cdp.send("Emulation.setLocaleOverride", { locale: "en-US" }).catch(() => null);
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: TZ }).catch(() => null);
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
  const frames = [];
  let n = 0;
  cdp.on("Page.screencastFrame", (p) => {
    const file = path.join(framesDir, `f${String(++n).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(p.data, "base64"));
    frames.push({ file, wall: p.metadata?.timestamp ? p.metadata.timestamp * 1000 : Date.now() });
    void cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => null);
  });

  await setupPage(cdp);
  const evaluate = makeEval(cdp);
  const termFile = path.join(WORK, "term.html");
  writeFileSync(termFile, termHtml({ jsonlPath: SESSION, setupCmd: SETUP_CMD, runCmd: RUN_CMD, mcpUrl: MCP_URL, w: VW, h: VH }));
  await cdp.send("Page.navigate", { url: BASE + "/overview" });
  await sleep(2500);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: VW * DPR, maxHeight: VH * DPR, everyNthFrame: 1 });
  await sleep(800);

  const vars = { hosted: sessionEvents(SESSION).request };
  if (!vars.hosted) throw new Error("the session log does not end with a paid request");
  log(`hosted request from the session log: ${vars.hosted.display}`);
  const fill = (s) => s.replace(/\{([\w.-]+)\}/g, (_, k) => k.split(".").reduce((o, p) => o?.[p], vars) ?? "");
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
      d.style.cssText = 'position:fixed;inset:auto;margin:0;padding:0;border:0;left:${x - 24}px;top:${y - 24}px;width:48px;height:48px;border-radius:50%;background:rgba(29,78,216,.32);box-shadow:0 0 0 3px rgba(255,255,255,.95),0 0 0 6px rgba(29,78,216,.5);pointer-events:none;transition:transform .55s ease-out,opacity .55s ease-out;overflow:visible';
      document.body.appendChild(d); try { d.showPopover(); } catch (e) {}
      requestAnimationFrame(() => requestAnimationFrame(() => { d.style.transform = 'scale(1.8)'; d.style.opacity = '0'; }));
      setTimeout(() => d.remove(), 800); })()`);
  const mouse = (type, x, y, extra = {}) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "mouse", ...extra });
  const overlay = (id, css, html) =>
    evaluate(`(() => { let d = document.getElementById(${JSON.stringify(id)});
      if (${html === null ? "true" : "false"}) { if (d) { d.style.transition = 'opacity .25s'; d.style.opacity = '0'; setTimeout(() => d.remove(), 260); } return; }
      if (!d) { d = document.createElement('div'); d.id = ${JSON.stringify(id)}; d.setAttribute('popover','manual'); d.style.cssText = ${JSON.stringify(css)} + ';opacity:0;transition:opacity .25s'; document.body.appendChild(d); try { d.showPopover(); } catch (e) {} requestAnimationFrame(() => requestAnimationFrame(() => (d.style.opacity = '1'))); }
      d.innerHTML = ${JSON.stringify(html ?? "")}; })()`);
  const pollUntil = async (js, timeout, seg) => {
    const t0 = Date.now();
    for (;;) {
      if (await evaluate(`!!(${fill(js)})`).catch(() => false)) return;
      if (Date.now() - t0 > timeout) throw new Error(`timeout in "${seg.id}": ${fill(js)}`);
      await sleep(150);
    }
  };

  // visible clock of the current segment; warps compress [w0, w1] wall time into `into` seconds
  let segStart = 0;
  let warps = [];
  const visible = (wall = Date.now()) => {
    let v = (wall - segStart) / 1000;
    for (const w of warps) {
      if (w.w1 === undefined) continue;
      if (wall >= w.w1) v -= (w.w1 - w.w0) / 1000 - w.into;
      else if (wall > w.w0) v = (w.w0 - segStart) / 1000 - warps.filter((x) => x !== w && x.w1 !== undefined && x.w1 <= w.w0).reduce((s, x) => s + (x.w1 - x.w0) / 1000 - x.into, 0) + ((wall - w.w0) / (w.w1 - w.w0)) * w.into;
    }
    return v;
  };

  async function act(a, seg, recording) {
    if (a.at !== undefined) {
      const target = seg.cues[a.at].start + (a.plus ?? 0);
      while (recording && visible() < target) await sleep(30);
    } else if (a.sleep !== undefined) await sleep(a.sleep * 1000);
    else if (a.nav) {
      const url = fill(a.nav);
      const cut = { w0: Date.now() };
      await cdp.send("Page.navigate", { url: /^https?:/.test(url) ? url : BASE + url });
      await sleep(300);
      if (a.wait) await pollUntil(a.wait, a.timeout ?? 30000, seg);
      // hard cut: the load time is removed from the timeline (a warp into 0.1 s) and its frames (blank page,
      // skeletons) are dropped, except the last one, which shows the loaded page at the cut
      await sleep(250);
      cut.w1 = Date.now();
      if (recording) {
        (seg.cuts ??= []).push(cut);
        warps.push({ w0: cut.w0, w1: cut.w1, into: 0.1 });
      }
    } else if (a.tap) {
      const sel = fill(a.tap.sel);
      await find(sel, a.tap.text);
      await sleep(120);
      const r2 = await find(sel, a.tap.text);
      if (!a.quiet) await ripple(r2.x, r2.y);
      await mouse("mouseMoved", r2.x, r2.y, { buttons: 0 });
      await mouse("mousePressed", r2.x, r2.y);
      await sleep(60);
      await mouse("mouseReleased", r2.x, r2.y);
      await sleep(250);
    } else if (a.wait) await pollUntil(a.wait, a.timeout ?? 15000, seg);
    else if (a.scroll) {
      if (a.scroll.y !== undefined) await evaluate(`window.scrollTo({ top: ${a.scroll.y}, behavior: 'smooth' })`);
      else {
        await find(a.scroll.sel, a.scroll.text).catch(() => null);
        await evaluate(`(() => { const re = ${a.scroll.text ? `new RegExp(${JSON.stringify(a.scroll.text)}, 'i')` : "null"};
          const el = [...document.querySelectorAll(${JSON.stringify(a.scroll.sel)})].find((e) => !re || re.test((e.innerText || '').trim()));
          el?.scrollIntoView({ behavior: 'smooth', block: ${JSON.stringify(a.scroll.block ?? "center")} }); })()`);
      }
      await sleep((a.dur ?? 1) * 1000);
    } else if (a.zoom) {
      // main-region punch-in: the crop's left edge sits on the sidebar border and its right edge on the viewport edge,
      // so no word or card is cut at the sides; vertically the window starts just above the target (or centres on it)
      const r = await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(fill(a.zoom.sel))})].find((e) => { const b = e.getBoundingClientRect(); return b.width > 1 && b.height > 1; });
        if (!el) return null; const b = el.getBoundingClientRect(); return { y: b.top, h: b.height }; })()`);
      if (!r) throw new Error(`zoom target not found: ${a.zoom.sel}`);
      const left = a.zoom.left ?? SIDEBAR;
      const z = VW / (VW - left);
      const winH = VH / z;
      const cyCss = Math.min(VH - winH / 2, Math.max(winH / 2, a.zoom.center ? r.y + r.h / 2 : r.y - 14 + winH / 2));
      const t0 = visible();
      const zm = { a: t0, b: t0 + a.zoom.dur, cx: ((left + VW) / 2) * K, cy: cyCss * K, z };
      if (a.zoom.async) seg.openZoom = zm; // held until the next { hold } (or the end of the segment)
      (seg.zooms ??= []).push(zm);
      log(`  zoom ${a.zoom.sel} x${z.toFixed(3)} ${t0.toFixed(1)}-${(t0 + a.zoom.dur).toFixed(1)}s`);
      if (!a.zoom.async) await sleep(a.zoom.dur * 1000);
    } else if (a.node) {
      await a.node(vars, BASE, evaluate);
    } else if (a.warp) {
      const w = { w0: Date.now(), into: a.warp.into };
      if (recording) warps.push(w);
      await overlay("demo-tag", TAG_CSS, `${esc(a.warp.label)} · sped up`);
      const t0 = Date.now();
      for (;;) {
        const ok = typeof a.warp.until === "function" ? await a.warp.until(vars, BASE) : await evaluate(`!!(${fill(a.warp.until)})`).catch(() => false);
        if (ok) break;
        if (Date.now() - t0 > (a.warp.timeout ?? 240000)) throw new Error(`warp timeout in ${seg.id}`);
        await sleep(a.warp.until instanceof Function ? 2000 : 200);
      }
      if (a.warp.reload) {
        await cdp.send("Page.reload", {});
        await sleep(300);
        await pollUntil(a.warp.readyJs ?? "true", 30000, seg);
      }
      await sleep(400);
      await overlay("demo-tag", TAG_CSS, null);
      await sleep(300);
      w.w1 = Date.now();
      log(`  warp "${a.warp.label}": ${((w.w1 - w.w0) / 1000).toFixed(1)}s real -> ${a.warp.into}s`);
    } else if (a.say !== undefined) {
      // a narration line starts now (never before the previous line ended + GAP, never before LEAD)
      const i = a.say;
      const prevEnd = i === 0 ? LEAD : seg.cues[i - 1].end + (seg.gaps?.[i - 1] ?? GAP);
      while (visible() < prevEnd) await sleep(20);
      const t = visible();
      seg.cues[i] = { start: t, end: t + seg.lineDur[i], text: lineText(seg.lines[i]), top: !!a.top };
    } else if (a.hold !== undefined) {
      const target = seg.cues[a.hold].end + (a.plus ?? 0);
      while (visible() < target) await sleep(20);
      if (seg.openZoom) {
        seg.openZoom.b = Math.max(seg.openZoom.a + 1.0, visible());
        seg.openZoom = null;
      }
    } else if (a.js) {
      await evaluate(a.js);
    } else if (a.term !== undefined) {
      if (a.term === "load") {
        await cdp.send("Page.navigate", { url: `file://${termFile}` });
        await sleep(600);
      } else {
        const [c2, ev, end] = a.term.at.map((i) => seg.cues[i].start);
        const off = visible();
        await evaluate(`window.play({ cmd2At: ${(c2 - off).toFixed(2)}, eventsAt: ${(ev - off).toFixed(2)}, endAt: ${(end + (a.term.plus ?? 0) - off).toFixed(2)} }), true`);
      }
    } else if (a.tg !== undefined) {
      if (a.tg === null) await overlay("demo-tg", TG_CSS, null);
      else {
        const v = vars[a.tg.from];
        const agents = (await (await fetch(`${BASE}/api/agents`)).json()).agents ?? [];
        const ag = agents.find((x) => x.name === a.tg.agent);
        // budget as the notifier measures it: before this purchase is committed
        const budget = ag && ag.monthly_limit_cents != null ? { monthSpentCents: ag.month_spent_cents, monthlyLimitCents: ag.monthly_limit_cents } : null;
        const card = cardText(v, a.tg.agent, budget);
        vars[`${a.tg.from}_card`] = card;
        await overlay("demo-tg", TG_CSS, tgHtml("Telegram approval card: the text the Reins bot sends (not sent here)", card));
      }
    } else throw new Error(`unknown action ${JSON.stringify(a)}`);
  }

  for (const seg of SEGMENTS) {
    if (seg.card) continue;
    seg.cues = [];
    for (const a of seg.prep ?? []) await act(a, seg, false);
    await sleep(300);
    warps = [];
    segStart = Date.now();
    const seed = frames.at(-1);
    for (const a of seg.actions) await act(a, seg, true);
    if (seg.cues.length !== seg.lines.length || seg.cues.some((c) => !c)) throw new Error(`${seg.id}: not every line has a { say }`);
    const target = seg.cues.at(-1).end + (seg.tail ?? TAIL);
    if (visible() > target + 0.05) log(`  WARN ${seg.id}: actions ran ${(visible() - seg.cues.at(-1).end).toFixed(2)}s past the last line`);
    while (visible() < target) await sleep(30);
    if (seg.openZoom) {
      seg.openZoom.b = visible() - 0.05;
      seg.openZoom = null;
    }
    const end = Date.now();
    seg.duration = Math.max(target, visible(end));
    const segFrames = [];
    if (seed) segFrames.push({ file: seed.file, v: 0 });
    const inSeg = frames.filter((f) => f.wall >= segStart && f.wall <= end);
    for (const f of inSeg) {
      const c = (seg.cuts ?? []).find((x) => f.wall >= x.w0 && f.wall < x.w1);
      if (!c) segFrames.push({ file: f.file, v: Math.max(0, visible(f.wall)) });
      else if (f === inSeg.filter((g) => g.wall >= c.w0 && g.wall < c.w1).at(-1)) segFrames.push({ file: f.file, v: Math.max(0, visible(c.w1)) });
    }
    seg.frames = segFrames;
    seg.warps = warps.map((w) => ({ realSeconds: (w.w1 - w.w0) / 1000, into: w.into }));
    log(`segment ${seg.id}: ${seg.duration.toFixed(2)}s, ${segFrames.length} frames`);
  }
  await cdp.send("Page.stopScreencast");
  return vars;
}

/* ── 5. encode ─────────────────────────────────────────────────────────────── */
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

function zoomFilter(zooms) {
  const even = (n) => 2 * Math.round(n / 2);
  if (!zooms.length) return `[1:v]scale=${SCR_W}:${SCR_H}:flags=lanczos,setsar=1,fps=${FPS}[scr]`;
  const R = 0.35;
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
    const common = ["-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3), "-r", String(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", out.replace(/\.mp4$/, ".mov")];
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
    outs.push(out.replace(/\.mp4$/, ".mov"));
    log(`encoded ${seg.id} (${dur.toFixed(2)}s)`);
  }
  // join (video copied), then one loudness pass on the whole narration (two-pass loudnorm, -16 LUFS, -1.5 dBTP)
  const list = path.join(dir, "all.txt");
  writeFileSync(list, outs.map((o) => `file '${o}'`).join("\n"));
  const joined = path.join(dir, "joined.mov");
  run(FFMPEG, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
  const m = loudMeasure(joined);
  mkdirSync(path.dirname(OUT), { recursive: true });
  run(FFMPEG, ["-y", "-v", "error", "-i", joined, "-c:v", "copy", "-af", `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", OUT]);
  const total = probe(OUT);
  log(`wrote ${OUT} (${total.toFixed(2)}s)`);
  return total;
}

function loudMeasure(file) {
  const txt = execFileSync("/bin/sh", ["-c", `"${FFMPEG}" -hide_banner -nostats -i "${file}" -vn -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null - 2>&1`]).toString();
  return JSON.parse(txt.slice(txt.lastIndexOf("{"), txt.lastIndexOf("}") + 1));
}

/* ── main ──────────────────────────────────────────────────────────────────── */
try {
  mkdirSync(WORK, { recursive: true });
  if (!existsSync(SESSION)) throw new Error(`session log not found: ${SESSION}`);
  log(`work=${WORK} out=${OUT}`);
  await buildAudio();
  if (args["audio-only"]) {
    log(`narration total ${SEGMENTS.reduce((s, x) => s + x.lineDur.reduce((a, b) => a + b, 0), 0).toFixed(1)}s`);
    await shutdown(0);
  }
  const cdp = await launchChrome();
  prepareDb();
  await startServer();
  const vars = await record(cdp);
  await renderStage(cdp);
  for (const seg of SEGMENTS) segAudio(seg);
  const total = encode();
  writeFileSync(
    path.join(WORK, "summary.json"),
    JSON.stringify(
      {
        out: OUT,
        totalSeconds: total,
        tts: ttsStats,
        requests: { a2: vars.a2?.display_id, a4: vars.a4?.display_id },
        segments: SEGMENTS.map((s) => ({ id: s.id, start: s.start, seconds: s.duration, warps: s.warps, cues: s.cues.map((c) => ({ start: s.start + c.start, end: s.start + c.end, text: c.text })) })),
      },
      null,
      2,
    ),
  );
  log(`done: ${total.toFixed(1)}s · ${SEGMENTS.map((s) => `${s.id} ${s.duration.toFixed(1)}`).join(" · ")}`);
  await shutdown(0);
} catch (e) {
  console.error("[rec] FAILED:", e.stack ?? e.message);
  await shutdown(1);
}
