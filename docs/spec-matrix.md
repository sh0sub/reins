# Spec matrix (artifact `paypal*` vs running product)

Audit round 2, 2026-11-01 (round 1 rows re-verified against a fresh seed). Product run with `PAYPAL_ENV=fake`, temp DB, no Claude or Telegram. Screenshots at 1440 and 390 px.
`pnpm test` 215/215 pass, `pnpm typecheck` clean, `pnpm lint` clean.
Status: match / gap / blocked.

| id | artifact section | expected | status | evidence |
|---|---|---|---|---|
| S1-flow | S1 Onboarding | Connect PayPal sandbox: Use demo merchant, verified badge, Continue enabled after step 2 | match | /setup: demo merchant click gives Verified + "oauth2/token 200" |
| S1-layout | S1 Onboarding | No sidebar, centered column, left value-prop panel (hero, 3 feature cards, mini approval card), "Setup · Step 2 of 3" header, Skip for now | match | /setup is bare (no sidebar): navy hero with "Hold the reins on AI spending.", 3 feature cards, mini approval cards, 3-step stepper, "Setup · Step N of 3" + Skip for now; stacks below 960 px (fix-r1/setup-1440.png, setup-390.png; AppShell.tsx, setup/page.tsx) |
| S1-states | S1 Onboarding | Empty (Continue disabled), loading "Checking credentials…", error caption, success | match | setup/page.tsx:183, Continue present, error path in tests |
| S1-vault-treasury | S1 / flow A | $0.01 vault check and Treasury fallback as two choices on one card | match | setup step 2 lists Automatic vault, Supervised, Treasury |
| S1-telegram | S1 / flow A | Link Telegram step with @ReinsApproveBot | blocked | needs real bot token/phone; card text covered by apps/bot/test |
| SHELL-sidebar-agents | S2/S4/S5/S7 shell | Sidebar lists agents with cap %, Sandbox badge, workspace + user (Minji Park), merchant email | match | Agents list with cap % (paused = grey dot), Sandbox badge, workspace row, PayPal card with merchant email, user block "Minji Park @minji_builds" (static demo identity, product has no accounts); hidden under 950 px (fix-r1/overview-1440.png, Nav.tsx, lib/shell.ts, test/shell.test.ts) |
| SHELL-cmdk | S2/S4/S5/S6/S7 top bar | "Search requests, agents… ⌘K" in top bar | match | Top-bar field + Cmd/Ctrl+K palette over pages, agents and requests (arrows, Enter, Esc); "fiverr" finds R-0022 and opens its drawer (fix-r1/cmdk-1440.png, cmdk-search-1440.png, CommandPalette.tsx) |
| SHELL-pending | top bar | Pending N shortcut, Live chip | match | d-overview.png |
| WIN-first-screen-value | S1/S7 first impression | First screen states the promise and the 3-act story and shows Sandbox state | match | "/" opens the S1 hero ("Hold the reins on AI spending.") until PayPal is connected, then Overview, which carries the same tagline under the title; Sandbox badge in the sidebar brand row (fix-r1/setup-1440.png, overview-1440.png, app/page.tsx) |
| S2-agent-list | S2 Agents | List with name, status chip, $used/$cap bar, header "Agents N", New agent button | gap | list+bars match; New agent is an inline input with a stray placeholder (d-agents.png) |
| S2-mandate-form | S2 Agents | Purpose, categories + AI suggest, 3 amounts, scale line, allowed/blocked chips, expiry, auto-pay line | match | d-agents.png |
| S2-version-select | S2 Agents | "v3 · current ▾" selector in editor header, versions list in the left column | match | r2 fix: `<select aria-label="Mandate version">` (v3 · current, v2, v1) in the editor header; picking an older version loads it in the editor ("Viewing v1 ... Saving creates v4", Back to current); Mandate versions and Recent requests moved under the agents list (fix-r2/agents-scout-1440.png, agents-v1-1440.png, agents/page.tsx) |
| S2-versions-diff | S2 Agents | Version list, changed-field highlight, "changed in vN" | match | Tighten mandate saved v2, "changed in v2", versions list updated (f-tighten-saved.png) |
| S2-mcp | S2 Agents | MCP snippet (`npx -y @reins/mcp`, REINS_URL), masked key, Copy/Regenerate, 4-tool note | match | r2 fix: snippet is `npx -y @reins/mcp` with `REINS_API_KEY` (masked `rk_…redacted`) and `REINS_URL` = this app's own origin, no placeholders; create/rotate return the same shape with the full key once; `apps/mcp` reads `REINS_URL` (and `REINS_API_URL`). Partial: `@reins/mcp` is not published to npm (needs the user's npm account), so the screen and README say `pnpm mcp:stdio` runs the same server from a clone (fix-r2/agents-scout-1440.png, service.ts, stdio.ts) |
| S2-states | S2 Agents | Empty text, skeleton, toast "cap must be ≥ auto-approve", success toast | match | MandateEditor.tsx:195, toast "Mandate v2 saved. Applies to new requests." |
| S3-telegram-cards | S3 Telegram | Approval card, blocked card without Approve, paid edit, 5 states | match | apps/bot/src/cards.ts, apps/bot/test (real device not verifiable) |
| S3-keyboard | S3 Telegram | 2x2 keyboard | match | 4 rows incl. Approve+always allow and Pause (Should S3/S5 additions) |
| S4-kpis | S4 Ledger | Paid, Blocked, Requests, Agents "3 · 2 active · 1 paused" | match | 4 tiles across; seed now pauses Desk Restock Bot so it reads "3 · 2 active · 1 paused"; "Paid by agent" chart moved below the grid (fix-r1/ledger-1440.png, scripts/seed.ts) |
| S4-grid | S4 Ledger | AG Grid with Time/Item/Merchant/Amount/Decision/Status/PayPal ID/Risk in view, group by agent, status chips, sticky totals | match | Grid gets the full content width; column widths, 8 px cell padding and icon-only Recon let Time, ID, Item, Merchant, Amount, Decision, Status, PayPal ID, Recon and Risk all show at 1440 px with no horizontal scroll; groups expanded, totals row pinned (fix-r1/ledger-1440.png, LedgerGrid.tsx) |
| S4-expand | S4 Ledger | Row expansion with EN/KO reason, mandate version, capture id, recon | match | expansion + drawer (f-drawer-ok.png) |
| S4-filters | S4 Ledger | Period, agent, status, search, Export CSV | match | d-ledger.png |
| S4-states | S4 Ledger | Empty, loading, sync error with cached data, success | match | LedgerGrid.tsx:263, router.ts:112 |
| S5-inbox | S5 Approvals | Pending list, detail with mandate check, Reins check, activity, Ask agent, deny reasons, shortcuts A/D | match | d-inbox.png, inbox/page.tsx:12 |
| S5-approve | S5 Approvals | Approve runs payment, card leaves queue | match | Approve: "Approved. Finish checkout on PayPal…", row to "Checkout open", pending 2 to 1 (supervised mode) |
| S5-allow | S5 Approvals | "Also allow merchant up to $X" | match | "Approve + always allow vercel.com" |
| S5-empty | S5 Approvals | All clear + recent decisions | match | inbox/page.tsx:598 |
| S6-drawer | S6 Detail | Right drawer: timeline ms, hard-rule table with 3 FAIL, risk meter, EN/KO, snapshot, raw MCP, Tighten mandate, Pause, Esc | match | f-drawer-ok.png; Esc closes |
| S6-model-line | S6 Detail | "Model: Claude · 412 tokens · 1.9 s" | match | r2 fix: drawer shows `Model: Claude · 412 tokens · 1.9 s` for R-0143. Real runs record tokens (Claude usage) and latency in the llm decision (audit.ts, claudeAuditor.ts), the seed records scripted values flagged `seeded: true`; timeline reads "LLM audit · Claude"; overview caption "Auto summary" instead of "Template · Claude is off" (fix-r2/drawer-1440.png, RequestDrawer.tsx modelLine, test/seed.test.ts) |
| S6-tighten | S6 Detail / flow C | Tighten mandate prefills block fiverr.com + cap $60 | match | /agents?...&block=fiverr.com&cap=60, saved as v2 |
| S6-deeplink | S6 Detail | /ledger/R-0143 style link | gap | `?r=R-0022` (display id) gives "Audit log unavailable"; only internal ids work |
| S7-kpis | S7 Overview | Spent / Decisions bar / Saved you, status chip | match | d-overview.png |
| S7-bars-donut | S7 Overview | Cap bars to ledger filter, AG Charts donut with total, category filter, period toggle | match | donut palette deviation is justified in docs/design.md |
| S7-feed-summary | S7 Overview | Recent decisions feed + AI weekly summary with warning box and Review/Edit | match | d-overview.png |
| S7-summary-data | S7 Overview | Summary says "$84.98 this week, 6 purchases" | match | r2 fix: "This week your agents spent $84.98 across 6 purchases. Research Scout is closest to its cap at 68%." plus the fiverr injection warning with Review R-0143 / Tighten mandate; seed places 6 purchases in the current ISO week on any run date (tested for 4 dates). Not done: the mockup's "2.1× usual pace" chip needs prior-month history, which the 24-request plan seed does not have, so it is not invented (fix-r2/overview-1440.png, seed.ts, test/seed.test.ts) |
| DATA-seed | Flow C numbers | 24 requests: Auto 19 · Human 4 · Blocked 1, blocked $450, 2 active + 1 paused, R-0143, versions v3/v2/v1 | match | r2 fix: 24 requests all this month, Auto 19 · Human 4 · Blocked 1 on both Overview and Ledger tiles (ledger tiles now use the same outcome split), blocked $450.00, $117.97 of $410, 1 pending (R-0142), fiverr = R-0143, Research Scout v3 current / v2 snapshot for R-0143 / v1; scripts/demo/prep-db.mjs resets mandates to v1 for the video takes. Per-agent amounts differ from the mockup (which does not add up to its own totals): 24% / 68% / 9% (fix-r2/ledger-1440.png, overview-1440.png, seed.ts, test/seed.test.ts) |
| F-MVP-M1-M14 | Features MVP | M1-M14 | match | 210 tests incl. integration flow B; M7/M8 real PayPal not run (no network spend) |
| F-Should-S1-S7 | Features Should | Overview, ask agent, anomalies, receipts, instant allow, DevOps agent | match | design.md, cf75afb; S7 APIMatic gap below |
| F-S7-APIMatic | Features S7 | APIMatic Context Plugin use recorded in README + commits | gap | README claims APIMatic target; checklist says no usage evidence |
| FLOW-A | Flow A | Onboarding to first agent | match | setup, then agents |
| FLOW-B | Flow B | AUTO / ASK / DENY endings | match | tests/integration + inbox/ledger UI |
| FLOW-C | Flow C | Review, tighten mandate, v-next | match | f-tighten-saved.png |
| LAYOUT-responsive | Mockup layouts | 390 px usable, no horizontal overflow | match | scrollWidth 390 on all 5 pages |
| SUB-readme-api | Submission | README with API table, architecture, 5-minute install | gap | README has no API table (checklist #41) |
| SUB-video | Submission | YouTube video under 3:00 | blocked | no video file in repo; upload needs user YouTube account |
| SUB-live-demo | Submission | Render URL + Use demo merchant | blocked | needs user Render account |
| SUB-devpost | Submission | Devpost form | blocked | needs user account; copy ready in docs/submission/devpost.md |
| SUB-checklist-stale | Submission | Checklist matches repo | gap | (r2 unchanged) still says 200 tests, "no commit", prior-art line not in video; now 210 tests and committed |
| TEST-suite | Tests | test/typecheck/lint green | match | 215/215, tsc clean, eslint clean |
| R2-ledger-1440-clip | S4 Ledger | All grid rows and Risk column visible at 1440 | match | r2 fix: group rows no longer sticky (nothing slides under them), grid starts at the top on first render, vertical scrollbar lane reserved so the fitted columns keep Risk fully visible, also with a row expanded; the dev-only "14 Issues" badge is the AG Grid trial notice in `next dev` (fix-r2/ledger-grid-1440.png, ledger-expanded-1440.png, LedgerGrid.tsx) |
| R2-s2-version-diff | S2 Agents | Version dropdown, versions in left column, "changed in vN" | match | r2 fix: see S2-version-select; "changed in v3" chip shows on Blocked merchants (fix-r2/agents-scout-1440.png) |
| R2-month-boundary | S7 Overview | Heading and period match data | gap | r2: at Nov 1 03:00 KST shows "October at a glance" (UTC month) while listing Nov 1 pending rows; low |

