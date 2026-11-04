import type { NextConfig } from "next";

// REINS_NEXT_DIST_DIR lets a second dev server run beside the first (scripts/demo/record-video.mjs --real) without sharing .next
const config: NextConfig = {
  distDir: process.env.REINS_NEXT_DIST_DIR || ".next",
  transpilePackages: ["@reins/core", "@reins/db", "@reins/bot"],
  serverExternalPackages: ["@libsql/client", "libsql", "drizzle-orm", "@anthropic-ai/sdk", "grammy"],
  typedRoutes: false,
};

export default config;
