/**
 * Prints the exact Telegram card text the real notifier would send for a request view (used by the demo video
 * recorder to show the card as plain text; the video does not imitate Telegram's UI).
 *   tsx scripts/demo/card-text.ts <input.json>   input: { kind: "approval" | "blocked", view, agentName, budget? }
 */
import { readFileSync } from "node:fs";
import { approvalCard, blockedCard } from "@reins/bot";

const input = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const card = input.kind === "blocked" ? blockedCard(input.view, input.agentName) : approvalCard(input.view, input.agentName, { ttlMinutes: input.ttlMinutes ?? 30, budget: input.budget ?? null });
process.stdout.write(JSON.stringify({ text: card.text, buttons: card.buttons.map((row) => row.map((b) => b.text)) }));
