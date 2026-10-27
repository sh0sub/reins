import { createRouter } from "@/server/router";
import { getContext } from "@/server/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handle = createRouter(getContext, { adminToken: process.env.REINS_ADMIN_TOKEN || undefined });

export const GET = handle;
export const POST = handle;
