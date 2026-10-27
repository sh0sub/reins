import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@reins/core", "@reins/db", "@reins/bot"],
  serverExternalPackages: ["@libsql/client", "libsql", "drizzle-orm", "@anthropic-ai/sdk", "grammy"],
  typedRoutes: false,
};

export default config;
