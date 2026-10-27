import { describe, expect, it } from "vitest";
import { ClaudeCategorySuggester, MockCategorySuggester, suggestCategories } from "../src/policy/categories.ts";
import type { MessagesParseClient } from "../src/policy/claudeAuditor.ts";

describe("M3 category suggestions", () => {
  it("mock maps purpose keywords to categories", async () => {
    expect(await new MockCategorySuggester().suggest("Keep dev infra running: domain renewals, hosting and API credits")).toEqual(["domains", "hosting", "api-credits"]);
  });
  it("Claude suggester normalizes output; failures fall back to keywords", async () => {
    const ok = { messages: { parse: async () => ({ parsed_output: { categories: ["Market Research", "datasets", "datasets"] } }) } } as unknown as MessagesParseClient;
    expect((await suggestCategories(new ClaudeCategorySuggester({ client: ok }), "buy reports")).categories).toEqual(["market-research", "datasets"]);
    const broken = { messages: { parse: async () => { throw new Error("down"); } } } as unknown as MessagesParseClient;
    expect(await suggestCategories(new ClaudeCategorySuggester({ client: broken }), "market research reports")).toEqual({ categories: ["research"], source: "mock" });
    expect((await suggestCategories(undefined, "  ")).categories).toEqual([]);
  });
});
