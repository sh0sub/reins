/**
 * Spike #31 — run: pnpm spike scripts/spikes/channel3.ts
 * Needs .env: CHANNEL3_API_KEY. POST https://api.trychannel3.com/v1/search (x-api-key header), per
 * channel3.ai/docs/guides/make-a-search. MCP setup page (channel3.ai/docs/mcp) could not be read (미확인).
 * Writes docs/spikes/channel3.md.
 */
import { requireEnv, writeReport } from "./lib.ts";

const { CHANNEL3_API_KEY } = requireEnv("CHANNEL3_API_KEY");
const sections: Array<[string, string]> = [];
const res = await fetch("https://api.trychannel3.com/v1/search", {
  method: "POST",
  headers: { "x-api-key": CHANNEL3_API_KEY, "content-type": "application/json" },
  body: JSON.stringify({ query: "market research report AI agents", limit: 3 }),
});
const text = await res.text();
sections.push(["Search", `HTTP ${res.status}\n\n\`\`\`json\n${text.slice(0, 3000)}\n\`\`\``]);
sections.push(["MCP setup (fill in)", "- Channel3 MCP server URL/command from channel3.ai/docs/mcp: __\n- Add it next to Reins in agents/claude_desktop_config.json (M14)."]);
writeReport("channel3.md", "Spike #31: Channel3 search + MCP", sections);
