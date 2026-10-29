import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOL_NAMES } from "../src/server.ts";

const root = resolve(fileURLToPath(import.meta.url), "../../../..");

describe("stdio server (real child process)", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: resolve(root, "node_modules/.bin/tsx"),
      args: [resolve(root, "apps/mcp/src/stdio.ts")],
      env: {
        PATH: process.env.PATH ?? "",
        REINS_API_KEY: "rk_live_test_dummy",
        REINS_API_URL: "http://127.0.0.1:9",
      },
      stderr: "ignore",
    });
    client = new Client({ name: "stdio-test", version: "0" });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
  }, 30000);

  it("lists exactly the 4 tools with input schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools).toHaveLength(4);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  }, 30000);

  it("returns isError (no crash) when the API is unreachable", async () => {
    const res = await client.callTool({ name: "get_mandate", arguments: {} });
    expect(res.isError).toBe(true);
    const again = await client.listTools();
    expect(again.tools).toHaveLength(4);
  }, 30000);
});

describe("agent config files", () => {
  const files = ["agents/claude_desktop_config.json", ".mcp.json.example"];

  function strings(v: unknown, out: string[] = []): string[] {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
    return out;
  }

  for (const f of files) {
    it(`${f} is valid, has reins + channel3, and contains no secrets`, () => {
      const json = JSON.parse(readFileSync(resolve(root, f), "utf8"));
      expect(Object.keys(json.mcpServers)).toEqual(expect.arrayContaining(["reins", "channel3"]));
      for (const s of strings(json)) {
        expect(s).not.toMatch(/rk_live_[A-Za-z0-9]{20,}/);
        expect(s).not.toMatch(/\b[a-f0-9]{32,}\b/i);
        if (!s.includes("/")) expect(s).not.toMatch(/[A-Za-z0-9+=_-]{40,}/);
        expect(s).not.toMatch(/@[\w-]+\.\w+/);
      }
      const env = json.mcpServers.reins.env as Record<string, string>;
      expect(env.REINS_API_KEY).toMatch(/^\$\{/);
      for (const v of Object.values(env)) expect(v).toMatch(/\$\{/);
    });
  }
});
